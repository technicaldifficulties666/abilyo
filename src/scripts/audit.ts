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

## MANDATORY STEPS — EXECUTE IN ORDER:

STEP 0 — DOM SNAPSHOT (do this first, before anything else):
Call 'get_dom_snapshot' with "${url}".
Read the 'structuralIssues' and 'summary' returned. Note 'existingLandmarkTags' — this is your ground truth for what landmarks already exist on the page. You MUST NOT suggest adding a landmark that already appears in this list as a duplicate.

STEP 1 — AXE + AI SCAN:
Call 'observe_accessibility_issues' with "${url}".

STEP 2 — EXTRACT CODE FOR EACH UNIQUE RULE:
For each entry in 'technicalViolations' (keyed by 'ruleId'), call 'extract_code_snippets' ONCE.
- Use the FIRST instance's 'cssSelector' as the selector argument.
- Collect ALL instance cssSelectors from the 'instances' array into the 'selectors' field of your report entry.
- Set 'instanceCount' to the Axe 'instanceCount' field (number of affected elements for this rule).
- For 'color-contrast': MUST be processed and included. If Axe returns contrast violations, include them with ALL affected selectors and the contrast ratio from instance 'data' (fgColor, bgColor, contrastRatio). This is typically the highest-volume category.
- For 'region', 'bypass', 'landmark-*', or any rule where the fix involves wrapping siblings in a landmark: pass 'useParentElement: true' to extract_code_snippets. This fetches the full parent container so the suggestedFix can wrap ALL children without truncation.
- ONE ruleId = ONE report entry. Never create separate entries for different instances of the same rule.

STEP 3 — SEMANTIC & STRUCTURAL GAPS:
Review 'semanticObservations' and 'structuralIssues' (from the snapshot) for issues Axe did not catch.
Call 'extract_code_snippets' for each new, non-duplicate issue found.
Issues to check explicitly if not already covered by Axe:
  * Images with generic alt text ('profile-image', 'photo', 'img', 'icon')
  * Missing or skipped heading levels (h1 → h3 skipping h2)
  * focus indicators (are keyboard outlines visible?)
  * Colour contrast (visually obvious low-contrast text)
  * Buttons or icon-only links with no accessible label

STEP 4 — GENERATE REPORT:
Call 'generate_accessibility_report' with the complete deduplicated list.

## HARD RULES:
- ONE <main> per page. If the snapshot shows mainCount >= 1, never wrap individual elements in <main>.
- ONE entry per Axe ruleId. All instances go in one entry's 'selectors' array.
- 'suggestedFix' MUST differ from 'currentCode'.
- 'currentCode' must never be the string "null" or a placeholder like "<img src='image-source.jpg'>".
- Pass the site owner's name as 'siteContext' on every extract_code_snippets call.
- Set summary.passedChecks to the 'passedChecksCount' value returned by 'observe_accessibility_issues'.
- Set summary.totalAffectedElements to the sum of all issue instanceCounts.
- Set summary.categoryBreakdown to counts per category: content/cognitive/visual/motor/structural.
- All fields required: element, selectors, elementType, message, issue, help, severity, wcagCriteria, wcagName, currentCode, suggestedFix, explanation, category, instanceCount, impactedUsers, businessRisk, legalStandard.`;

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
      const summary = report.summary as any;
      console.log(`\n📊 Summary:`);
      console.log(`   Total Issues: ${summary?.totalIssues || report.issues.length}`);
      console.log(`   Total Affected Elements: ${summary?.totalAffectedElements ?? report.issues.length}`);
      console.log(`   Compliance Score: ${summary?.complianceScore ?? 'N/A'}%  |  Verdict: ${summary?.verdict || 'N/A'}`);
      console.log(`   Passed Checks: ${summary?.passedChecks ?? 'N/A'}`);
      console.log(`   🔴 Critical: ${summary?.critical || 0}`);
      console.log(`   🟠 Serious:  ${summary?.serious || 0}`);
      console.log(`   🟡 Moderate: ${summary?.moderate || 0}`);
      console.log(`   🟢 Minor:    ${summary?.minor || 0}`);
      const catBr = summary?.categoryBreakdown;
      if (catBr) {
        console.log(`\n📁 Category Breakdown:`);
        console.log(`   Content: ${catBr.content ?? 0}  |  Cognitive: ${catBr.cognitive ?? 0}  |  Visual: ${catBr.visual ?? 0}  |  Motor: ${catBr.motor ?? 0}  |  Structural: ${catBr.structural ?? 0}`);
      }
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
        console.log(`   Category: ${(issue as any).category || 'N/A'}  |  Affected: ${(issue as any).instanceCount ?? 1} element(s)`);
        console.log(`   WCAG: ${issue.wcagCriteria} — ${issue.wcagName}`);
        console.log(`   Severity: ${issue.severity.toUpperCase()}`);
        if ((issue as any).businessRisk) console.log(`   ⚠️  Risk: ${(issue as any).businessRisk}`);
        if ((issue as any).legalStandard?.length) console.log(`   ⚖️  Legal: ${(issue as any).legalStandard.join(', ')}`);
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
      const cleanReport = JSON.stringify(
        report,
        (_key, value) =>
          typeof value === 'string'
            ? value.replace(/\x00([eE]9)/g, '\u00e9').replace(/\0/g, '')
            : value,
        2
      );
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
