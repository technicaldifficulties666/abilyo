import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Stagehand } from '@browserbasehq/stagehand';
import { openai } from '@ai-sdk/openai';
import { Mastra } from '@mastra/core';
import { injectAxe } from 'axe-playwright';

// Zod schemas for type-safe extraction
const AccessibilityIssueSchema = z.object({
  element: z.string().describe('Stable CSS selector (id, class, or attribute). NEVER an XPath expression.'),
  selectors: z.array(z.string()).describe('All CSS selectors for all instances of this issue (from Axe cssSelector or derived). No XPaths.'),
  elementType: z.string().describe('Type of element (button, img, heading, a, div, etc.)'),
  message: z.string().describe('A 1-sentence headline of the error'),
  issue: z.string().describe('Detailed explanation of why this violates accessibility'),
  help: z.string().describe('Actionable, step-by-step developer instructions to fix it'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  wcagCriteria: z.string().describe('The WCAG number (e.g., 1.4.3)'),
  wcagName: z.string().describe('The name of the WCAG criterion'),
  currentCode: z.string().describe('The original, broken HTML snippet'),
  suggestedFix: z.string().describe('The corrected HTML/ARIA code (MUST be different)'),
  explanation: z.string().describe('Briefly explain how the fix solves the specific issue'),
  category: z.enum(['content', 'cognitive', 'visual', 'motor', 'structural'])
    .describe('Issue category: content=alt/labels/links, cognitive=headings/flow/language, visual=contrast/zoom/focus, motor=keyboard/touch/bypass, structural=landmarks/aria'),
  instanceCount: z.number()
    .describe('Total page elements affected by this rule. From Axe instanceCount for technical violations; 1 for semantic-only issues.'),
  impactedUsers: z.array(z.enum(['vision', 'hearing', 'mobility', 'cognitive', 'seizure']))
    .describe('Disability groups that cannot use this page element due to this issue'),
  businessRisk: z.string()
    .describe('Potential legal, SEO, or reputational consequence if not fixed (1-2 sentences)'),
  legalStandard: z.array(z.string())
    .describe('Applicable legal standards this violates, e.g. ["ADA Title III", "AODA", "EAA", "Section 508"]'),
});

const AccessibilityReportSchema = z.object({
  url: z.string(),
  pageTitle: z.string(),
  scanDate: z.string().optional().describe('ISO 8601 timestamp — set automatically by the report tool'),
  issues: z.array(AccessibilityIssueSchema),
  summary: z.object({
    totalIssues: z.number(),
    totalAffectedElements: z.number().default(0)
      .describe('Sum of instanceCounts across all issues — reflects the true scale of violations'),
    critical: z.number(),
    serious: z.number(),
    moderate: z.number(),
    minor: z.number(),
    passedChecks: z.number().default(0)
      .describe('Axe rules that passed — pass the passedChecksCount from observe_accessibility_issues'),
    complianceScore: z.number().default(0)
      .describe('0-100 score — computed by report tool, set 0 as placeholder'),
    verdict: z.enum(['compliant', 'partially-compliant', 'non-compliant']).default('non-compliant')
      .describe('Computed by report tool — set non-compliant as placeholder'),
    categoryBreakdown: z.object({
      content: z.number(),
      cognitive: z.number(),
      visual: z.number(),
      motor: z.number(),
      structural: z.number(),
    }).default({ content: 0, cognitive: 0, visual: 0, motor: 0, structural: 0 }),
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

      // 1. Technical Scan: Full Axe ruleset via raw axe.run()
      // Using page.evaluate to access passes count (needed for compliance score calculation)
      let technicalViolations: any[] = [];
      let passedChecksCount = 0;
      try {
        await injectAxe(stagehand.page);
        const axeRaw = await stagehand.page.evaluate(async () => {
          const results = await (window as any).axe.run(document, {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
            },
          });
          return {
            violations: results.violations,
            passesCount: (results.passes || []).length,
          };
        });
        technicalViolations = axeRaw.violations;
        passedChecksCount = axeRaw.passesCount;
        console.log(`[Axe] ${technicalViolations.length} violation rules, ${passedChecksCount} passed checks.`);
      } catch (axeError: any) {
        console.warn('[Axe] Scan failed, continuing with AI only:', axeError.message);
      }

      // 2. Restructure Axe data: ONE entry per rule with all affected instances grouped.
      // This is the key structural fix — prevents the LLM from creating duplicate issues
      // for each instance of the same rule (e.g. 3 empty links → 1 issue, not 3).
      const axeViolationSummary = technicalViolations.map((v: any) => ({
        ruleId: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        wcagTags: (v.tags || []).filter((t: string) => t.startsWith('wcag') || t.startsWith('best-practice')),
        instanceCount: v.nodes?.length || 0,
        // All CSS selectors from Axe (Axe always emits CSS, never XPath)
        instances: (v.nodes || []).map((n: any) => ({
          cssSelector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target || ''),
          html: n.html || '',
          failureSummary: n.failureSummary || '',
          // Axe check data — most useful for color-contrast: { fgColor, bgColor, contrastRatio, expectedContrastRatio }
          data: n.any?.[0]?.data || n.none?.[0]?.data || null,
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
        passedChecksCount,
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
    useParentElement: z.boolean().optional().describe(
      'When true, fetches the PARENT container outerHTML instead of the element itself. ' +
      'Use for landmark/structural violations where multiple sibling elements all need to be wrapped together ' +
      '(e.g. region, bypass, landmark rules). Prevents the LLM from seeing only one child and truncating the fix.'
    ),
  }),
  execute: async ({ selector, issueDescription, siteContext, useParentElement }) => {
    const stagehand = await getStagehand();
    try {
      // Step 1: Reliably get raw outerHTML AND derive a stable CSS selector.
      // Handles both CSS selectors (from Axe) and XPath expressions (from Stagehand observe).
      let rawHTML = '';
      let stableCSSSelector = ''; // derived CSS selector when input is XPath
      try {
        const isXPath =
          selector.startsWith('xpath=') ||
          selector.startsWith('/html') ||
          selector.startsWith('(//') ||
          selector.startsWith('//');

        if (isXPath) {
          const xpathExpr = selector.startsWith('xpath=') ? selector.slice(6) : selector;
          const resolved = await stagehand.page.evaluate((xpath: string) => {
            const result = document.evaluate(
              xpath, document, null,
              XPathResult.FIRST_ORDERED_NODE_TYPE, null
            );
            const el = result.singleNodeValue as Element | null;
            if (!el) return { html: '', cssSelector: '' };

            const html = el.outerHTML;

            // Build a stable CSS selector: prefer #id, data attrs, href, meaningful classes
            const elHtml = el as HTMLElement;
            if (elHtml.id) return { html, cssSelector: `#${elHtml.id}` };

            // Prefer href for links (most stable identity for <a> elements)
            if (el.tagName === 'A') {
              const href = el.getAttribute('href');
              if (href && href !== '' && href !== '#' && href !== '/') {
                return { html, cssSelector: `a[href="${href}"]` };
              }
            }

            // Data attributes (framework-agnostic, very stable)
            const dataAttrs = Array.from(el.attributes).filter(a => a.name.startsWith('data-') && !a.name.startsWith('data-sr'));
            for (const attr of dataAttrs) {
              const candidate = `[${attr.name}="${attr.value}"]`;
              try { if (document.querySelectorAll(candidate).length === 1) return { html, cssSelector: candidate }; } catch {}
            }

            // Non-CSS-in-JS class names (skip hashed classes like css-1abc2de)
            const stableClasses = Array.from(el.classList).filter(
              c => !/^css-[a-z0-9]+$/i.test(c) && c.length > 2
            );
            for (const cls of stableClasses) {
              const candidate = `${el.tagName.toLowerCase()}.${cls}`;
              try { if (document.querySelectorAll(candidate).length === 1) return { html, cssSelector: candidate }; } catch {}
            }

            // role attribute
            const role = el.getAttribute('role');
            if (role) {
              const candidate = `${el.tagName.toLowerCase()}[role="${role}"]`;
              try { if (document.querySelectorAll(candidate).length === 1) return { html, cssSelector: candidate }; } catch {}
            }

            // Fallback: tag name only
            return { html, cssSelector: el.tagName.toLowerCase() };
          }, xpathExpr);

          rawHTML = resolved.html || '';
          stableCSSSelector = resolved.cssSelector || '';
        } else {
          rawHTML = await stagehand.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            return el ? el.outerHTML : '';
          }, selector);
        }
      } catch {
        // Selector not resolvable — AI will identify element by description
      }

      // Canonical selector to use in the report — CSS if available, XPath input as last resort
      let canonicalSelector = stableCSSSelector || selector;

      // LANDMARK/STRUCTURAL FIX: Upgrade to parent container's outerHTML.
      // The parent holds ALL sibling children at once, so the LLM cannot truncate or drop any of them.
      // Only skip upgrade if parent is <body> or <html> (too broad to be useful).
      if (useParentElement) {
        try {
          const upgraded = await stagehand.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const parent = el.parentElement;
            if (!parent || ['body', 'html'].includes(parent.tagName.toLowerCase())) return null;
            const html = parent.outerHTML;
            // Derive stable selector for parent using same priority ladder
            const parentEl = parent as HTMLElement;
            if (parentEl.id) return { html, cssSelector: `#${parentEl.id}` };
            const stableClasses = Array.from(parent.classList).filter(
              (c: string) => !/^css-[a-z0-9]+$/i.test(c) && c.length > 2
            );
            const tag = parent.tagName.toLowerCase();
            if (stableClasses.length > 0) return { html, cssSelector: `${tag}.${stableClasses[0]}` };
            const role = parent.getAttribute('role');
            if (role) return { html, cssSelector: `${tag}[role="${role}"]` };
            return { html, cssSelector: tag };
          }, canonicalSelector);
          if (upgraded?.html) {
            rawHTML = upgraded.html;
            if (upgraded.cssSelector) canonicalSelector = upgraded.cssSelector;
            console.log(`[extract] useParentElement: upgraded to parent selector "${canonicalSelector}"`);
          }
        } catch {
          // Parent resolution failed — fall back to original element HTML
        }
      }

      // Step 2: Use Stagehand AI to write the fix
      const extraction = await stagehand.extract({
        instruction: `The element to fix: "${selector}".
The accessibility issue: "${issueDescription}".
Site owner / company context: "${siteContext || 'the site owner'}".
Canonical CSS selector (use this as 'element' key, NOT the XPath): "${canonicalSelector}".

Raw HTML already extracted (use this as currentCode if non-empty):
${rawHTML || '(Not found via selector — locate visually and extract)'}

TASK:
1. 'currentCode': Use the raw HTML above verbatim. If empty, find the element visually and return its outerHTML.
2. 'suggestedFix': The COMPLETE corrected HTML. MUST differ from currentCode. If the HTML above is a parent container, the suggestedFix MUST include ALL child elements — do NOT truncate, abbreviate, or drop any children.
3. DO NOT use placeholder names like "John Doe" — use the actual name from siteContext.
4. VALID HTML ONLY — no JSX (<>), no incomplete tags (</>), no null bytes.
5. 'explanation': One sentence explaining how the fix addresses the specific WCAG violation.`,
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
          : rawHTML || `<!-- Element matching "${selector}" — HTML not extractable -->`;

      return {
        success: true,
        ...extraction,
        currentCode: finalCurrentCode,
        cssSelector: canonicalSelector, // always a CSS selector — use this as 'element'
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
});

// Tool: DOM Snapshot — extracts a structural brief of the page for accessibility analysis.
// Must be called FIRST before observation, so the auditor knows what landmarks already exist.
const domSnapshotTool: any = createTool({
  id: 'get_dom_snapshot',
  description: `Extract a structural brief of the page: existing landmarks, heading hierarchy, images, links, and form inputs. Call this FIRST, before observe_accessibility_issues.`,
  inputSchema: z.object({
    url: z.string().describe('The current page URL (for reference — page must already be loaded by navigate or observe)'),
  }),
  execute: async ({ url: _url }: { url: string }) => {
    const stagehand = await getStagehand();
    try {
      const snapshot = await stagehand.page.evaluate(() => {
        const landmarks = Array.from(
          document.querySelectorAll('header, nav, main, footer, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"]')
        ).map(el => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          id: (el as HTMLElement).id || null,
          hasContent: (el.textContent?.trim().length || 0) > 0,
        }));

        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(el => ({
          level: parseInt(el.tagName[1]),
          text: el.textContent?.trim().slice(0, 120) || '',
          id: (el as HTMLElement).id || null,
        }));

        const images = Array.from(document.querySelectorAll('img')).map(el => ({
          src: (el.getAttribute('src') || '').slice(0, 80),
          alt: el.getAttribute('alt'),
          hasAlt: el.hasAttribute('alt'),
          isDecorativeEmpty: el.getAttribute('alt') === '',
          isGenericAlt: ['image', 'photo', 'img', 'picture', 'profile-image', 'profile', 'avatar', 'icon'].includes(
            (el.getAttribute('alt') || '').toLowerCase().trim()
          ),
        }));

        const links = Array.from(document.querySelectorAll('a')).map(el => ({
          href: el.getAttribute('href') || '',
          text: el.textContent?.trim().slice(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || null,
          isEmpty: (el.textContent?.trim() || '') === '' && !el.getAttribute('aria-label'),
          isGeneric: ['click here', 'here', 'read more', 'learn more', 'more', 'link'].includes(
            (el.textContent?.trim() || '').toLowerCase()
          ),
        }));

        const formElements = Array.from(
          document.querySelectorAll('input:not([type="hidden"]), textarea, select')
        ).map(el => {
          const id = (el as HTMLElement).id;
          const hasExplicitLabel = id ? !!document.querySelector(`label[for="${id}"]`) : false;
          return {
            type: el.tagName.toLowerCase() + (el.getAttribute('type') ? `[type="${el.getAttribute('type')}"]` : ''),
            id: id || null,
            hasExplicitLabel,
            hasAriaLabel: el.hasAttribute('aria-label'),
            hasAriaLabelledby: el.hasAttribute('aria-labelledby'),
            placeholder: el.getAttribute('placeholder') || null,
          };
        });

        return { landmarks, headings, images, links, formElements };
      });

      // Derive pre-computed structural issues to guide the auditor
      const structuralIssues: string[] = [];
      const mainCount = snapshot.landmarks.filter(l => l.tag === 'main' || l.role === 'main').length;
      const navCount = snapshot.landmarks.filter(l => l.tag === 'nav' || l.role === 'navigation').length;
      const h1Count = snapshot.headings.filter(h => h.level === 1).length;
      const emptyLinks = snapshot.links.filter(l => l.isEmpty).length;
      const genericAltImages = snapshot.images.filter(i => i.isGenericAlt && !i.isDecorativeEmpty).length;
      const missingAltImages = snapshot.images.filter(i => !i.hasAlt).length;
      const unlabelledInputs = snapshot.formElements.filter(
        f => !f.hasExplicitLabel && !f.hasAriaLabel && !f.hasAriaLabelledby
      ).length;

      if (mainCount === 0) structuralIssues.push('NO <main> landmark — page lacks a main content region');
      if (mainCount > 1) structuralIssues.push(`MULTIPLE <main> elements (${mainCount}) — only one is allowed per page`);
      if (navCount === 0) structuralIssues.push('NO <nav> landmark — navigation links lack semantic wrapper');
      if (h1Count === 0) structuralIssues.push('NO <h1> element — page missing top-level heading');
      if (h1Count > 1) structuralIssues.push(`MULTIPLE <h1> elements (${h1Count}) — only one is recommended`);
      if (emptyLinks > 0) structuralIssues.push(`${emptyLinks} empty link(s) with no text or aria-label`);
      if (missingAltImages > 0) structuralIssues.push(`${missingAltImages} image(s) with no alt attribute at all`);
      if (genericAltImages > 0) structuralIssues.push(`${genericAltImages} image(s) with generic/non-descriptive alt text`);
      if (unlabelledInputs > 0) structuralIssues.push(`${unlabelledInputs} form input(s) with no accessible label`);

      // Check for skipped heading levels
      const levels = snapshot.headings.map(h => h.level);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] > 1) {
          structuralIssues.push(`Heading level skipped: h${levels[i-1]} → h${levels[i]} (missing h${levels[i-1]+1})`);
          break;
        }
      }

      return {
        success: true,
        snapshot,
        structuralIssues,
        summary: {
          mainCount,
          navCount,
          h1Count,
          totalHeadings: snapshot.headings.length,
          totalImages: snapshot.images.length,
          emptyLinks,
          genericAltImages,
          missingAltImages,
          unlabelledInputs,
          existingLandmarkTags: snapshot.landmarks.map(l => l.tag),
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
});

// Tool 3: Report
const generateAccessibilityReportTool = createTool({
  id: 'generate_accessibility_report',
  description: `Validates and finalizes the accessibility report.`,
  inputSchema: AccessibilityReportSchema,
  execute: async (report) => {
    console.log(`\n✅ Tool triggered: Generating report for ${report.pageTitle}`);

    // Recompute all derived summary fields from actual issue data for accuracy
    const issues = report.issues as any[];
    const totalAffectedElements = issues.reduce((sum: number, i: any) => sum + (i.instanceCount || 1), 0);

    const categoryBreakdown = {
      content:    issues.filter((i: any) => i.category === 'content').length,
      cognitive:  issues.filter((i: any) => i.category === 'cognitive').length,
      visual:     issues.filter((i: any) => i.category === 'visual').length,
      motor:      issues.filter((i: any) => i.category === 'motor').length,
      structural: issues.filter((i: any) => i.category === 'structural').length,
    };

    const passedChecks = (report.summary as any).passedChecks || 0;
    const rawScore = passedChecks / Math.max(1, passedChecks + totalAffectedElements) * 100;
    const complianceScore = Math.round(rawScore);
    const verdict: 'compliant' | 'partially-compliant' | 'non-compliant' =
      complianceScore >= 80 ? 'compliant' :
      complianceScore >= 50 ? 'partially-compliant' :
      'non-compliant';

    const finalReport = {
      ...report,
      scanDate: new Date().toISOString(),
      summary: {
        ...report.summary,
        totalAffectedElements,
        categoryBreakdown,
        complianceScore,
        verdict,
        passedChecks,
      },
    };

    // Save to file
    const fs = require('fs');
    const path = require('path');
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `accessibility-report-${timestamp}.json`;
    const reportsDir = path.join(process.cwd(), 'reports');

    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filepath = path.join(reportsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(finalReport, null, 2));

    console.log(`💾 REPORT SAVED INTERNALLY TO: ${filepath}`);
    console.log(`📊 Compliance: ${complianceScore}% (${verdict}) | ${totalAffectedElements} affected elements across ${issues.length} rules`);

    return {
      success: true,
      data: finalReport,
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

### AXE DATA STRUCTURE (CRITICAL — READ BEFORE PROCESSING technicalViolations):
Each entry in 'technicalViolations' has a 'ruleId' and an 'instances' array.
- 'ruleId' = ONE WCAG rule (e.g., "link-name"). This maps to EXACTLY ONE report issue entry.
- 'instances' = every element on the page that violates this rule. 'instanceCount' tells you how many.
- RULE: Create ONE issue entry per ruleId. Put ALL instance cssSelectors in the 'selectors' array. Use the first instance's 'html' as 'currentCode'.
- NEVER create separate report entries for different instances of the same ruleId — that is a duplication failure.
- Example: ruleId "link-name" with 3 instances → ONE issue entry, selectors: [".css-nhg5kz", ".css-d4gr0s", ".css-abc123"].

### THE ONE-LANDMARK RULE (CRITICAL — prevents hallucinated broken HTML):
Before generating ANY fix that introduces a landmark element (<main>, <nav>, <header>, <footer>):
1. Check 'existingLandmarkTags' from the DOM snapshot ('get_dom_snapshot' summary).
2. A page must have EXACTLY ONE <main>. If 'existingLandmarkTags' contains 'main', NEVER wrap individual elements in <main>. The issue is that content is OUTSIDE the existing <main>, not that multiple <main>s are needed.
3. If <main> is ABSENT, the 'selectors' array should contain ALL orphaned non-landmark content selectors. The 'suggestedFix' MUST show a single <main> wrapping ALL of them together — not just the first one. Example pattern:

   WRONG (wraps only one element):
     suggestedFix: "<main><div data-sr-id='0'>...</div></main>"

   CORRECT (wraps every section):
     suggestedFix: "<main>\\n  <div data-sr-id='0'>...</div>\\n  <div data-sr-id='2'>...</div>\\n  <div data-sr-id='3'>...</div>\\n  <!-- all remaining page sections --></main>"
4. Same rule applies to <header>, <nav>, and <footer> — each appears at most once, wrapping ALL relevant content.
5. When flagging "content not contained by landmarks", the fix restructures ONE landmark to contain ALL affected content — never adds multiple landmark tags of the same type.

### LANDMARK FIX STRATEGY (prevents truncation — use this every time):
When calling 'extract_code_snippets' for any issue where the fix involves wrapping multiple sibling elements in a landmark (<main>, <nav>, <header>, <footer>):
- Pass 'useParentElement: true'.
- The tool will automatically fetch the PARENT container's full outerHTML. This gives the LLM all sibling children at once.
- In your 'suggestedFix', change the outer wrapper to the correct landmark tag (or insert the landmark inside it) and include EVERY child without exception. Do NOT abbreviate or comment out any child elements.
- The 'currentCode' returned will be the parent container. The 'element' key in the report should be the parent's CSS selector.
- This applies to: 'region' rule, 'bypass' rule, 'landmark-*' rules, any 'structuralIssues' entry involving landmark absence.

### ALT TEXT DISTINCTION (CRITICAL — prevents wrong issue classification):
- If an image has NO alt attribute at all (Axe ruleId: 'image-alt', domSnapshot 'hasAlt: false'): message = "Missing Alt Attribute", category = 'content'. Do NOT say "Non-Descriptive".
- If an image DOES have an alt but it is generic ('profile-image', 'photo', 'icon', 'avatar', 'img', 'image', 'picture', 'profile') — this is domSnapshot 'isGenericAlt: true': message = "Non-Descriptive Alt Text", category = 'content'. Do NOT say "Missing Alt Text".
- Always check the domSnapshot 'images' array and its 'hasAlt' + 'isGenericAlt' flags before classifying alt issues.

### COLOR-CONTRAST REPORTING (REQUIRED — highest-volume category on most pages):
Color contrast is the #1 cause of accessibility failures. Axe's 'color-contrast' ruleId fires once per element — a page can have 10–40+ affected elements:
- ONE report entry for ruleId 'color-contrast', but: 'instanceCount' = actual Axe instanceCount (could be 30+), ALL selectors in 'selectors[]'.
- 'issue': Mention actual failing contrast ratio from Axe's 'instance.data' (e.g., "2.1:1 vs 4.5:1 required for normal text"). Each instance 'data' object has: { fgColor, bgColor, contrastRatio, expectedContrastRatio }.
- 'suggestedFix': Show the corrected element with a CSS color/background-color that achieves >= 4.5:1 ratio.
- 'severity': 'serious', 'category': 'visual', 'wcagCriteria': '1.4.3', 'wcagName': 'Contrast (Minimum)'.
- NEVER omit or skip color-contrast findings — they account for the bulk of real-world accessibility violations.

### SUMMARY COMPUTATION (values to pass to generate_accessibility_report):
- 'passedChecks': The 'passedChecksCount' from 'observe_accessibility_issues' return data.
- 'totalAffectedElements': Sum of ALL issue instanceCounts across all issues.
- 'complianceScore': Set to 0 — the report tool recomputes accurately from passedChecks and totalAffectedElements.
- 'verdict': Set to 'non-compliant' as placeholder — overwritten by the report tool.
- 'categoryBreakdown': Count of issues per category (content/cognitive/visual/motor/structural).

### OUTPUT LOGIC:
0. Call 'get_dom_snapshot' FIRST with the target URL. This gives you:
   - Which landmarks already exist (so you never suggest adding duplicate <main>s)
   - The heading hierarchy (so you can spot skipped levels)
   - Empty links, missing alt images, unlabelled inputs (pre-computed in structuralIssues)
1. Call 'observe_accessibility_issues' to run Axe + AI semantic scan.
2. Process 'technicalViolations': for each unique ruleId, call 'extract_code_snippets' ONCE using the FIRST instance's cssSelector. Collect all instance cssSelectors into the 'selectors' array.
3. Process 'semanticObservations' and 'structuralIssues' from the snapshot: for issues Axe did NOT cover, call 'extract_code_snippets'.
4. Synthesize ALL issues into 'generate_accessibility_report'.
5. Identify the site owner from pageTitle and pass as 'siteContext' on every extract call.

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

1. **element**: The primary CSS selector. **RULE: NEVER use an XPath string (xpath=/html/...) here. If extract_code_snippets returned a 'cssSelector' field, use that. If you only have an XPath, derive the nearest id, class, href, or data-attribute selector manually.**
2. **selectors**: An array of all CSS selectors for all instances of this issue. Same rule — no XPaths.
3. **elementType**: The tag name or component type (e.g., "button", "a", "img").
4. **message**: A punchy headline (e.g., "Non-Descriptive Alt Text").
5. **issue**: A deep-dive into the problem. Why is this a barrier for a disabled user?
6. **help**: A 2-3 step actionable developer guide. Each step names the EXACT attribute, element, tag, or CSS property to change. Examples by issue type:
   - Link name: "1. Locate each icon-only <a> element. 2. Add aria-label='[Destination] — [Owner Name]' directly on the tag (e.g., aria-label='GitHub profile — Subaig Bindra'). 3. Verify with axe DevTools or a screen reader that the link now announces its destination."
   - Missing landmark: "1. Identify all content <div>s that sit directly under <body> outside any landmark. 2. Wrap them together in a single <main> element. 3. Confirm there is exactly one <main> on the page using browser DevTools (document.querySelectorAll('main').length === 1)."
   - Contrast: "1. Check the computed foreground and background colors in DevTools (Inspect > Styles). 2. Adjust the foreground or background CSS color until the contrast ratio reaches at least 4.5:1 for normal text or 3:1 for large text (use WebAIM Contrast Checker). 3. Apply the new color as a CSS variable or inline style and re-test with axe."
   - Alt text: "1. Identify the image's subject (person, product, or context) using surrounding content. 2. Replace the generic alt value with a descriptive phrase of 50-150 characters (e.g., alt='Headshot of Subaig Bindra, a Full-Stack Developer, smiling against a dark background'). 3. For purely decorative images, set alt='' (empty string) and add role='presentation'."
7. **severity**: Must be 'critical', 'serious', 'moderate', or 'minor'.
8. **wcagCriteria**: The specific number (e.g., "1.1.1").
9. **wcagName**: The formal name (e.g., "Non-text Content").
10. **currentCode**: The raw HTML string found on the page.
11. **suggestedFix**: Your corrected HTML. **RULE: suggestedFix MUST NOT equal currentCode.**
12. **explanation**: How your fix specifically addresses the WCAG violation.
13. **impactedUsers**: An array of disability groups affected. Choose from: 'vision', 'hearing', 'mobility', 'cognitive', 'seizure'. Most issues affect multiple groups.
    - Empty links/buttons → ['vision', 'mobility', 'cognitive']
    - Missing alt text → ['vision']
    - Heading hierarchy → ['vision', 'cognitive']
    - Contrast → ['vision', 'cognitive']
    - Keyboard trap / focus → ['vision', 'mobility']
    - Missing landmark → ['vision', 'cognitive', 'mobility']
14. **businessRisk**: 1-2 sentences on the ADA/AODA/EAA legal exposure, SEO penalty, or reputational damage if not fixed. Be specific.
    - Example: "Under ADA Title III and AODA, icon-only links without accessible names constitute a barrier for screen reader users, creating direct litigation exposure. This pattern was cited in 38% of 2023 web accessibility lawsuits."
15. **legalStandard**: An array of applicable regulations. Choose from: "ADA Title III", "AODA", "EAA", "Section 508", "EN 301 549", "CVAA".
16. **VALID HTML ONLY**: The suggestedFix must be valid, standard HTML. Do not include JSX fragments (<>), incomplete tags (</>), or null bytes (\u0000).

17. **category**: Classify into ONE: 'content' (alt text, link/button/form labels), 'cognitive' (heading hierarchy, reading order, language, navigation consistency), 'visual' (color contrast, zoom, text size, focus indicators), 'motor' (keyboard access, skip navigation, touch targets, focus order), 'structural' (missing landmarks, semantic HTML, ARIA roles).
18. **instanceCount**: Total page elements affected by this rule violation. Use Axe's 'instanceCount' for technical issues. For semantic-only issues, count affected elements manually (minimum 1). This powers the compliance score and affected-element totals the client sees.

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
    domSnapshotTool,
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