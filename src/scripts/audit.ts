#!/usr/bin/env ts-node

import * as dotenv from "dotenv";
import { aodaAuditorAgent, cleanup, AccessibilityReport } from "../mastra";
import { z } from "zod";

// Load environment variables
dotenv.config();

// Validate environment
function validateEnvironment() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ Error: OPENAI_API_KEY is required in .env file");
    process.exit(1);
  }
}

// Parse command line arguments
function parseArguments(): string {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("❌ Error: URL argument is required");
    console.log("\nUsage: npm run audit <URL>");
    console.log("Example: npm run audit https://example.com");
    process.exit(1);
  }

  const url = args[0];

  // Basic URL validation
  try {
    new URL(url);
    return url;
  } catch (error) {
    console.error(`❌ Error: Invalid URL "${url}"`);
    process.exit(1);
  }
}

// Main audit function
async function runAccessibilityAudit(url: string) {
  console.log("🔍 AI-Powered Accessibility Audit Starting...\n");
  console.log(`📍 Target URL: ${url}`);
  console.log(`🤖 Agent: AODA-Auditor (GPT-4o)`);
  console.log(
    `🌐 Browser: Stagehand (${process.env.STAGEHAND_ENV || "LOCAL"})`,
  );
  console.log(`📋 Standard: WCAG 2.2 Level AA\n`);
  console.log("─".repeat(60));

  try {
    // Step 1: Navigate and observe
    console.log("\n📊 Step 1: Navigating to URL and observing page...");

    const observationPrompt = `Perform a COMPLETE and EXHAUSTIVE accessibility audit on ${url}.

## MANDATORY STEPS — DO NOT SKIP ANY:

STEP 1: Call 'observe_accessibility_issues' with the URL to run both Axe-core and AI scans.

STEP 2: Process EVERY item in 'technicalViolations' (from Axe) AND 'semanticObservations' (from AI).
- For EACH violation, call 'extract_code_snippets' to get the HTML and generate a fix.
- Pass the page title as 'siteContext' on every call.
- Do NOT skip empty links, empty buttons, or heading hierarchy issues.
- Violations you MUST check explicitly:
  * Empty <a> tags (no text, no aria-label) — these are WCAG 4.1.2 violations
  * Missing or skipped heading levels — check for h1, then h2, h3 in order
  * Images with generic alt text like 'profile-image', 'photo', 'img'
  * Color contrast (flag any visually low-contrast text)
  * Focus indicators (tab through the page mentally — are outlines visible?)
  * Missing <main>, <nav>, <header>, <footer> landmarks
  * Form inputs without labels
  * Buttons or links with no descriptive text

STEP 3: After extracting ALL issues, call 'generate_accessibility_report' with the complete compiled list.

## RULES:
- Minimum expected issues for any real website: 4+. If you find fewer, you have missed something — go back and look harder.
- 'suggestedFix' MUST be different from 'currentCode'. If identical, rewrite until it isn't.
- 'currentCode' must NEVER be the string "null" — use the actual HTML or a descriptive comment.
- Every issue needs all fields: element, selectors, elementType, message, issue, help, severity, wcagCriteria, wcagName, currentCode, suggestedFix, explanation.
- Use the DEDUPLICATION rule: if the same issue appears on multiple elements, group them into one entry with multiple selectors.`;

    // Inside runAccessibilityAudit function in audit.ts:

    const response = await aodaAuditorAgent.generateLegacy(observationPrompt);

    // 1. Extract the report data from tool results
    const toolOutput = response.toolResults?.find(
      (t) => t.toolName === "generate_accessibility_report",
    );

    let report: AccessibilityReport | null = null;

    // Check Tool Results first (High Priority)
    if (toolOutput?.result) {
      report = toolOutput.result.data || toolOutput.result;
    }

    // Fallback: Check for JSON in text
    if (!report || !report.issues) {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          // Use the null scrub here so the console logs are also clean
          const cleanedJsonText = jsonMatch[0].replace(/\0/g, "");
          const parsed = JSON.parse(cleanedJsonText);
          if (parsed.issues) report = parsed;
        } catch (e) {
          console.error("Failed to parse fallback JSON:", e);
        }
      }
    }

    if (report && report.issues) {
      // Display formatted report
      console.log("\n📋 ACCESSIBILITY AUDIT REPORT");
      console.log("═".repeat(60));
      console.log(`\n🌐 URL: ${report.url}`);
      console.log(`📄 Page: ${report.pageTitle}`);
      console.log(`\n📊 Summary:`);
      console.log(
        `   Total Issues: ${report.summary?.totalIssues || report.issues.length}`,
      );
      console.log(`   🔴 Critical: ${report.summary?.critical || 0}`);
      console.log(`   🟠 Serious: ${report.summary?.serious || 0}`);
      console.log(`   🟡 Moderate: ${report.summary?.moderate || 0}`);
      console.log(`   🟢 Minor: ${report.summary?.minor || 0}`);
      console.log("\n" + "─".repeat(60));

      // Display each issue
      report.issues.forEach((issue, index) => {
        const severityEmoji =
          {
            critical: "🔴",
            serious: "🟠",
            moderate: "🟡",
            minor: "🟢",
          }[issue.severity] || "⚪";

        console.log(`\n${severityEmoji} Issue ${index + 1}: ${issue.issue}`);
        console.log(`   Element: ${issue.element}`);
        console.log(`   WCAG: ${issue.wcagCriteria} - ${issue.wcagName}`);
        console.log(`   Severity: ${issue.severity.toUpperCase()}`);
        console.log(`\n   ❌ Current Code:`);
        console.log(`   ${issue.currentCode.split("\n").join("\n   ")}`);
        console.log(`\n   ✅ Suggested Fix:`);
        console.log(`   ${issue.suggestedFix.split("\n").join("\n   ")}`);
        console.log(`\n   💡 Explanation:`);
        console.log(`   ${issue.explanation}`);
        console.log("\n" + "─".repeat(60));
      });

      // Save report to file
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `accessibility-report-${timestamp}.json`;
      const fs = require("fs");
      const path = require("path");

      const reportsDir = path.join(process.cwd(), "reports");
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }

      const filepath = path.join(reportsDir, filename);
      // Final safeguard in audit.ts
      const cleanReport = JSON.stringify(report, null, 2).replace(/\0/g, "");
      fs.writeFileSync(filepath, cleanReport);

      console.log(`\n💾 Full report saved to: ${filepath}`);
    } else {
      // Display raw output if we couldn't parse the report
      console.log("\n📋 AGENT RESPONSE:\n");
      console.log(response.text);
    }

    console.log("\n✅ Audit complete!\n");
  } catch (error) {
    console.error("\n❌ Error during audit:", error);
    throw error;
  } finally {
    // Cleanup
    console.log("🧹 Cleaning up browser resources...");
    await cleanup();
  }
}

// Main execution
async function main() {
  validateEnvironment();
  const url = parseArguments();

  try {
    await runAccessibilityAudit(url);
    process.exit(0);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { runAccessibilityAudit };
