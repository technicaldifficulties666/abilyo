#!/usr/bin/env ts-node

/**
 * PatchAgent — Phase 1: Static HTML / simple file patching
 *
 * Usage:
 *   npm run patch -- <report.json> <source-dir> [--dry-run]
 *
 * Reads approvedFixes from the report, finds currentCode in source files,
 * replaces it with suggestedFix, and writes the result back to disk.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ── Types ──────────────────────────────────────────────────────────────────
interface ApprovedFix {
  element: string;
  message: string;
  wcagCriteria: string;
  wcagName: string;
  severity: string;
  currentCode: string;
  suggestedFix: string;
  explanation: string;
}

interface PatchResult {
  fix: ApprovedFix;
  file: string;
  applied: boolean;
  reason?: string;
}

// ── File discovery ─────────────────────────────────────────────────────────
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

// For Phase 2 (React/SPA), add: ".jsx", ".tsx", ".vue", ".svelte"
// The LLM will handle HTML→JSX translation in that phase.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function walkDir(dir: string, exts: Set<string>): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full, exts));
    } else if (exts.has(path.extname(entry).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

// ── String matching ────────────────────────────────────────────────────────

/** Normalize whitespace for fuzzy matching — collapses runs of whitespace to single space */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Try to find `needle` in `haystack`.
 * Returns the exact substring to replace (preserving original whitespace)
 * or null if not found.
 */
function findInContent(haystack: string, needle: string): string | null {
  // 1. Exact match
  if (haystack.includes(needle)) return needle;

  // 2. Whitespace-normalized match: find the span in the original that maps to needle
  const normalNeedle = normalizeWs(needle);
  const normalHaystack = normalizeWs(haystack);
  if (!normalHaystack.includes(normalNeedle)) return null;

  // Walk the original looking for a span that normalises to normalNeedle
  const nl = normalNeedle.length;
  for (let i = 0; i < haystack.length; i++) {
    for (let j = i + normalNeedle.length; j <= haystack.length; j++) {
      const slice = haystack.slice(i, j);
      if (normalizeWs(slice) === normalNeedle) {
        return slice;
      }
    }
  }
  return null;
}

// ── Prompting ──────────────────────────────────────────────────────────────
function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}

// ── Core patch logic ───────────────────────────────────────────────────────
async function runPatchAgent(
  reportPath: string,
  sourceDir: string,
  dryRun: boolean,
) {
  console.log("\n🔧 PatchAgent — Phase 1: Static HTML\n");
  console.log(`📄 Report  : ${reportPath}`);
  console.log(`📁 Source  : ${path.resolve(sourceDir)}`);
  console.log(`🧪 Mode    : ${dryRun ? "DRY RUN (no files written)" : "LIVE"}\n`);
  console.log("─".repeat(60));

  // Load report
  if (!fs.existsSync(reportPath)) {
    console.error(`❌ Report not found: ${reportPath}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const approvedFixes: ApprovedFix[] = report.approvedFixes || [];

  if (!approvedFixes.length) {
    console.warn("⚠️  No approvedFixes found in report.");
    console.warn("   Run the audit first, approve fixes at the Phase 3 prompt, then patch.");
    process.exit(0);
  }

  console.log(`\n✅ ${approvedFixes.length} approved fix(es) to apply\n`);

  // Discover source files
  const sourceFiles = walkDir(sourceDir, HTML_EXTENSIONS);
  console.log(`🔍 Scanning ${sourceFiles.length} HTML file(s) in ${path.resolve(sourceDir)}\n`);

  if (!sourceFiles.length) {
    console.warn("⚠️  No HTML files found. Is the source directory correct?");
    console.warn("   Hint: pass the root of your website project as <source-dir>.");
    process.exit(0);
  }

  // Apply each fix
  const results: PatchResult[] = [];

  for (let i = 0; i < approvedFixes.length; i++) {
    const fix = approvedFixes[i];
    console.log(`\n[${i + 1}/${approvedFixes.length}] ${fix.message}`);
    console.log(`   Element  : ${fix.element}`);
    console.log(`   WCAG     : ${fix.wcagCriteria} — ${fix.wcagName}`);

    let matched = false;

    for (const filePath of sourceFiles) {
      const original = fs.readFileSync(filePath, "utf8");
      const found = findInContent(original, fix.currentCode);

      if (!found) continue;

      const patched = original.replace(found, fix.suggestedFix);

      const relPath = path.relative(process.cwd(), filePath);
      console.log(`\n   📂 Match found in: ${relPath}`);

      // Show a compact diff preview
      const currentPreview = fix.currentCode.length > 120
        ? fix.currentCode.slice(0, 120) + "..."
        : fix.currentCode;
      const fixPreview = fix.suggestedFix.length > 120
        ? fix.suggestedFix.slice(0, 120) + "..."
        : fix.suggestedFix;

      console.log(`\n   ─── Before ───`);
      console.log(`   ${currentPreview}`);
      console.log(`   ─── After  ───`);
      console.log(`   ${fixPreview}\n`);

      if (dryRun) {
        console.log(`   🧪 [DRY RUN] Would write: ${relPath}`);
        results.push({ fix, file: filePath, applied: false, reason: "dry-run" });
      } else {
        const confirm = await askYesNo(`   Write fix to ${relPath}? [Y/n] `);
        if (confirm) {
          fs.writeFileSync(filePath, patched, "utf8");
          console.log(`   ✅ Written: ${relPath}`);
          results.push({ fix, file: filePath, applied: true });
        } else {
          console.log(`   ⏭️  Skipped`);
          results.push({ fix, file: filePath, applied: false, reason: "skipped by user" });
        }
      }

      matched = true;
      break; // Only patch the first matching file per fix
    }

    if (!matched) {
      console.log(`   ⚠️  No match found in any HTML file.`);
      console.log(`   Hint: currentCode may differ from disk. Manual edit required.`);
      results.push({ fix, file: "", applied: false, reason: "currentCode not found in any file" });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const applied  = results.filter((r) => r.applied);
  const notFound = results.filter((r) => !r.applied && r.reason?.includes("not found"));
  const dryruns  = results.filter((r) => r.reason === "dry-run");
  const skipped  = results.filter((r) => !r.applied && r.reason === "skipped by user");

  console.log("\n" + "═".repeat(60));
  console.log("📊 PATCH SUMMARY");
  console.log("═".repeat(60));
  if (dryRun) {
    console.log(`  🧪 Would apply: ${dryruns.length}`);
  } else {
    console.log(`  ✅ Applied  : ${applied.length}`);
    console.log(`  ⏭️  Skipped  : ${skipped.length}`);
  }
  console.log(`  ❌ Not found: ${notFound.length}`);

  if (notFound.length) {
    console.log("\n  Not found (manual action needed):");
    notFound.forEach(({ fix }) => {
      console.log(`    • ${fix.message}  (${fix.element})`);
    });
  }

  if (dryRun && dryruns.length) {
    console.log(`\n✅ Dry run complete — ${dryruns.length} fix(es) ready to apply.`);
    console.log(`   Re-run without --dry-run to write changes.\n`);
  } else if (applied.length && !dryRun) {
    console.log(`\n✅ ${applied.length} file(s) patched. Ready to commit!\n`);
    console.log(`  git diff`);
    console.log(`  git add -A && git commit -m "a11y: apply ${applied.length} accessibility fix(es)"`);
  }

  console.log();
}

// ── Entry point ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const dryRun = flags.includes("--dry-run");

  if (args.length < 2) {
    console.error("❌ Usage: npm run patch -- <report.json> <source-dir> [--dry-run]");
    console.error("   Example: npm run patch -- reports/accessibility-report-XXX.json ./site");
    process.exit(1);
  }

  const [reportPath, sourceDir] = args;

  try {
    await runPatchAgent(reportPath, sourceDir, dryRun);
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ PatchAgent error:", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { runPatchAgent };
