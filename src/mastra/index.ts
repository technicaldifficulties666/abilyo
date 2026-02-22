import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Stagehand } from '@browserbasehq/stagehand';
import { openai } from '@ai-sdk/openai';
import { Mastra } from '@mastra/core';
import { injectAxe, getViolations } from 'axe-playwright';

// Zod schemas for type-safe extraction
const AccessibilityIssueSchema = z.object({
  element: z.string().describe('CSS selector of the element'),
  selectors: z.array(z.string()).describe('List of all CSS selectors for this element (from Axe)'),
  elementType: z.string().describe('Type of element (button, img, heading, etc.)'),
  message: z.string().describe('A 1-sentence headline of the error'),
  issue: z.string().describe('Detailed explanation of why this violates accessibility'),
  help: z.string().describe('Actionable, step-by-step developer instructions to fix it'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  wcagCriteria: z.string().describe('The WCAG number (e.g., 1.4.3)'),
  wcagName: z.string().describe('The name of the WCAG criterion'),
  currentCode: z.string().describe('The original, broken HTML snippet'),
  suggestedFix: z.string().describe('The corrected HTML/ARIA code (MUST be different)'),
  explanation: z.string().describe('Briefly explain how the fix solves the specific issue'),
});

const AccessibilityReportSchema = z.object({
  url: z.string(),
  pageTitle: z.string(),
  issues: z.array(AccessibilityIssueSchema),
  summary: z.object({
    totalIssues: z.number(),
    critical: z.number(),
    serious: z.number(),
    moderate: z.number(),
    minor: z.number(),
  }),
});

export type AccessibilityIssue = z.infer<typeof AccessibilityIssueSchema>;
export type AccessibilityReport = z.infer<typeof AccessibilityReportSchema>;

// Initialize Stagehand instance
let stagehandInstance: Stagehand | null = null;

async function getStagehand(): Promise<Stagehand> {
  if (!stagehandInstance) {
    const env = process.env.STAGEHAND_ENV || 'LOCAL';
    stagehandInstance = new Stagehand({
      env: env as 'LOCAL' | 'BROWSERBASE',
      verbose: 1,
      debugDom: true,
    });
    await stagehandInstance.init();
  }
  return stagehandInstance;
}

// Tool 1: Observe
const observeAccessibilityIssuesTool: any = createTool({
  id: 'observe_accessibility_issues',
  description: `Audits a URL using a hybrid of Axe-core (technical) and AI (semantic) observation.`,
  inputSchema: z.object({
    url: z.string().describe('The URL to audit'),
  }),
  execute: async ({ url }: { url: string }) => {
    const stagehand = await getStagehand();
    try {
      await stagehand.page.goto(url, { waitUntil: 'networkidle' });
      const pageTitle = await stagehand.page.title();

      // 1. Technical Scan: Run Axe-core (getViolations never throws on violations)
      let technicalViolations: any[] = [];
      try {
        await injectAxe(stagehand.page);
        technicalViolations = await getViolations(stagehand.page);
        console.log(`[Axe] Found ${technicalViolations.length} technical violations.`);
      } catch (axeError: any) {
        console.warn('[Axe] Scan failed, continuing with AI only:', axeError.message);
      }

      // 2. Also extract axe violations with HTML nodes for richer context
      const axeViolationSummary = technicalViolations.map((v: any) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes?.map((n: any) => ({
          html: n.html,
          target: n.target,
          failureSummary: n.failureSummary,
        })),
      }));

      // 3. Semantic Scan: Run AI Observation for issues Axe cannot detect
      const aiObservations = await stagehand.observe({
        instruction: `Perform a thorough accessibility review looking for ALL of the following:
1. EMPTY LINKS: <a> tags with no inner text and no aria-label (e.g., social media icon links)
2. EMPTY BUTTONS: <button> or <input type="submit"> with no visible label or aria-label
3. HEADING HIERARCHY: Is there an <h1>? Are any heading levels skipped (e.g., h2 → h4)? Does heading order make logical sense?
4. ALT TEXT QUALITY: Images with missing, generic ('image', 'photo', 'pic'), or non-descriptive alt text
5. LINK TEXT QUALITY: Links that say 'click here', 'read more', 'learn more', 'here', or similar
6. COLOR CONTRAST: Any text that visually appears hard to read against its background (light grey on white, etc.)
7. FOCUS INDICATORS: Are there visible outlines when tabbing through interactive elements?
8. FORM LABELS: Inputs without a visible <label> or aria-label
9. LANDMARK REGIONS: Is there a <main>, <nav>, <header>, <footer>? Or is the page all <div>s?
10. KEYBOARD TRAPS: Any modal, dropdown, or widget that may trap keyboard focus

List EVERY element you find with any of these issues. Be exhaustive.`,
      });

      return { 
        success: true, 
        url, 
        pageTitle, 
        technicalViolations: axeViolationSummary,
        semanticObservations: aiObservations,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
});

// Tool 2: Extract
const extractCodeSnippetsTool: any = createTool({
  id: 'extract_code_snippets',
  description: `Extract HTML/ARIA code and generate a WCAG-compliant fix.`,
  inputSchema: z.object({
    selector: z.string(),
    issueDescription: z.string(),
    siteContext: z.string().optional().describe('Context about the site owner or company to avoid generic names'),
  }),
  execute: async ({ selector, issueDescription, siteContext }) => {
    const stagehand = await getStagehand();
    try {
      // Step 1: Reliably get raw outerHTML via Playwright directly (avoids AI hallucinating "null")
      let rawHTML = '';
      try {
        rawHTML = await stagehand.page.evaluate((sel: string) => {
          // This code runs in the browser context, so 'document' is available
          const el = document.querySelector(sel);
          return el ? el.outerHTML : '';
        }, selector);
      } catch {
        // Selector may not be valid CSS — skip, AI will find element by description
      }

      // Step 2: Use Stagehand AI to write the fix
      const extraction = await stagehand.extract({
        instruction: `The element to fix: "${selector}".
The accessibility issue: "${issueDescription}".
Site owner / company context: "${siteContext || 'the site owner'}".

Raw HTML already extracted (use this as currentCode if non-empty):
${rawHTML || '(Not found via CSS selector — locate visually and extract)'}

TASK:
1. 'currentCode': Use the raw HTML above. If empty, find and return the element's outerHTML from the page.
2. 'suggestedFix': Return the COMPLETE corrected HTML. It MUST differ from currentCode.
3. DO NOT use placeholder names like "John Doe". Use the actual name from siteContext.
4. VALID HTML ONLY — no JSX, no fragments, no null bytes.
5. 'explanation': One sentence on how the fix addresses the WCAG violation.`,
        schema: z.object({
          currentCode: z.string(),
          suggestedFix: z.string(),
          explanation: z.string(),
        }),
      });

      // Step 3: Guarantee currentCode is never the string "null" or empty
      const finalCurrentCode =
        extraction.currentCode &&
        extraction.currentCode !== 'null' &&
        extraction.currentCode.trim() !== ''
          ? extraction.currentCode
          : rawHTML || `<!-- Element matching "${selector}" — HTML not extractable via selector -->`;

      return { success: true, ...extraction, currentCode: finalCurrentCode };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
});

// Tool 3: Report
// Replace your Tool 3 with this slightly cleaner version
const generateAccessibilityReportTool = createTool({
  id: 'generate_accessibility_report',
  description: `Validates and finalizes the accessibility report.`,
  inputSchema: AccessibilityReportSchema,
  execute: async (report) => {
    console.log(`\n✅ Tool triggered: Generating report for ${report.pageTitle}`);
    
    // Save to file directly from the tool
    const fs = require('fs');
    const path = require('path');
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `accessibility-report-${timestamp}.json`;
    const reportsDir = path.join(process.cwd(), 'reports');
    
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const filepath = path.join(reportsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    
    console.log(`💾 REPORT SAVED INTERNALLY TO: ${filepath}`);

    return {
      success: true,
      data: report,
      filePath: filepath
    };
  },
});

// System prompt for the AODA-Auditor agent
const SYSTEM_PROMPT = `You are an expert Web Accessibility Auditor specializing in WCAG 2.2 Level AA, AODA, ADA and EAA compliance.

Your mission is to identify accessibility barriers that prevent people with disabilities from using websites effectively. You go beyond what automated tools can detect by using visual AI to catch "soft" issues that require human-like judgment.

### YOUR DATA SOURCES:
1. **Technical Violations (Axe-core)**: Deterministic, math-based errors (Contrast ratios, missing landmarks, viewport settings). These are "Hard Truths."
2. **Semantic Observations (AI)**: Contextual, human-centric issues (Quality of alt text, logical heading hierarchy, descriptive link names). These are "User Experience Truths."

### CORE DIRECTIVES:
- **Merge & Deduplicate**: If Axe finds a contrast error and you also see it, merge them into a single, rich entry.
- **Remediation is King**: Your primary value is providing valid, corrected HTML. 
- **The "No-Lazy" Rule**: The 'suggestedFix' MUST be a modified version of 'currentCode'. If they are identical, you have failed. You must provide the ARIA attributes, semantic tags, or descriptive text required to pass WCAG 2.2 Level AA.
- **Fact-Check Names**: Before generating alt text or labels, check the 'pageTitle' or 'h1' to identify the person or company. Do not use placeholder names like "John Doe."

### REMEDIATION EXAMPLES:
- **If the issue is Generic Alt Text**: 
  - Current: <img src="pfp.png" alt="profile-image">
  - Fix: <img src="pfp.png" alt="Headshot of Subaig Bindra, a Full-Stack Developer, smiling against a dark background">
- **If the issue is Missing Landmark**:
  - Current: <div id="main-content">...</div>
  - Fix: <main id="main-content">...</main>
- **If the issue is a "Click Here" Link**:
  - Current: <a href="/resume">Click Here</a>
  - Fix: <a href="/resume" aria-label="Download Subaig Bindra's Résumé (PDF)">View Résumé</a>

### DEDUPLICATION RULE: If multiple elements have the same issue and the same fix (e.g., social media icons in the header and footer), group them into a single issue entry. List all relevant selectors in the selectors array, but only provide one currentCode and suggestedFix.

### OUTPUT LOGIC:
1. Analyze the 'technicalViolations' array. For each violation, call 'extract_code_snippets' to get the HTML.
2. Analyze the 'semanticObservations' array. For new issues Axe missed, call 'extract_code_snippets'.
3. Synthesize everything into the 'generate_accessibility_report' tool.
4. Before calling extract_code_snippets, identify the site owner from the page title and pass it into the siteContext parameter.

Be thorough. Be technical. Be the advocate for the user with disabilities.

KEY RESPONSIBILITIES:
1. **Visual Assessment**: Examine pages as a screen reader user or someone with low vision would experience them
2. **Semantic Analysis**: Check if HTML structure conveys meaning (headings, landmarks, relationships)
3. **Descriptive Content**: Evaluate if labels, alt text, and link text are truly descriptive (not just present)
4. **Logical Flow**: Verify reading order, heading hierarchy, and navigation structure make sense
5. **Context-Aware Fixes**: Provide specific HTML/ARIA code fixes that solve the actual problem

FOCUS AREAS (things scanners miss):
- **Alt text quality**: Is it descriptive or generic? Does "image of person" help? (No - describe who, what, context)
- **Heading hierarchy**: Are levels skipped (h2 → h4)? Is there a logical outline? Does the h1 reflect page purpose?
- **Link text**: Does "click here" or "learn more" tell you where you're going? (No - make it descriptive)
- **Button labels**: Does "Submit" indicate what's being submitted? Does an icon button have aria-label?
- **Form labels**: Visual proximity isn't enough - is there a programmatic <label> or aria-labelledby?
- **Contrast**: Can you visually see low contrast text/buttons? (not measured, just observed)
- **Landmarks**: Are there <nav>, <main>, <aside> regions? Or just divs?
- **Focus indicators**: Can you see where focus is when tabbing?
- **EAA Requirements**: Check for "Support services" information and "Accessibility statement" presence if applicable.

WCAG 2.2 LEVEL AA CRITERIA TO REFERENCE:
- 1.1.1 Non-text Content (alt text)
- 1.3.1 Info and Relationships (semantic HTML, labels, structure)
- 1.3.2 Meaningful Sequence (reading order)
- 1.4.3 Contrast (Minimum) (4.5:1 for text)
- 2.4.1 Bypass Blocks (skip links, landmarks)
- 2.4.6 Headings and Labels (descriptive, present where needed)
- 2.4.7 Focus Visible (keyboard focus indicators)
- 3.2.4 Consistent Identification (same function = same label)
- 3.3.2 Labels or Instructions (form guidance)
- 4.1.2 Name, Role, Value (ARIA on custom controls)

### REPORTING STRUCTURE (CRITICAL):
For every issue identified (from Axe or your own observation), you MUST generate a JSON object using these exact keys:

1. **element**: The primary CSS selector.
2. **selectors**: An array of all relevant selectors identifying the issue.
3. **elementType**: The tag name or component type (e.g., "button").
4. **message**: A punchy headline (e.g., "Non-Descriptive Alt Text").
5. **issue**: A deep-dive into the problem. Why is this a barrier for a disabled user?
6. **help**: Instructions for a developer (e.g., "Add an aria-label or change background to #222").
7. **severity**: Must be 'critical', 'serious', 'moderate', or 'minor'.
8. **wcagCriteria**: The specific number (e.g., "1.1.1").
9. **wcagName**: The formal name (e.g., "Non-text Content").
10. **currentCode**: The raw HTML string found on the page.
11. **suggestedFix**: Your corrected HTML. **RULE: suggestedFix MUST NOT equal currentCode.**
12. **explanation**: How your fix specifically addresses the WCAG violation.
13. **VALID HTML ONLY**: The suggestedFix must be valid, standard HTML. Do not include JSX fragments (<>), incomplete tags (</>), or non-standard characters like null bytes (\u0000).

### MERGE & DEDUPLICATION LOGIC:
- If Axe finds a technical error (like contrast) and you notice a semantic error (like a bad label) on the **same element**, merge them into ONE entry. 
- Use the Axe data for the 'message' and 'wcagCriteria', but use your reasoning to write a 'suggestedFix' that solves BOTH problems.

Remember: You're helping make the web accessible. Be thorough, specific, and actionable.`;

// Create the AODA-Auditor Agent
export const aodaAuditorAgent = new Agent({
  id: 'aoda-auditor-v1',
  name: 'AODA-Auditor',
  instructions: SYSTEM_PROMPT,
  model: openai('gpt-4o'),
  tools: {
    observeAccessibilityIssuesTool,
    extractCodeSnippetsTool,
    generateAccessibilityReportTool,
  },
});

// Mandatory for Mastra to recognize the agent
export const mastra = new Mastra({
  agents: { aodaAuditorAgent },
});

export async function cleanup() {
  if (stagehandInstance) {
    await stagehandInstance.close();
    stagehandInstance = null;
  }
}