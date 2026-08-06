// `tsc` (TypeScript compiler) compressor.
//
// `tsc --noEmit` (or `tsc -b`) on a project with type errors prints one
// diagnostic per line in the form:
//   `file.ts(LINE,COL): error TSxxxx: message`
// followed by a summary `Found N errors in M files.`
//
// Two problems for the model:
//   1. tsc prints DUPLICATE adjacent lines for the same error when the
//      project is built with certain `incremental`/`composite` settings
//      (the same diagnostic is emitted once per affected root). A wall of
//      identical lines wastes context.
//   2. On a large codebase, dozens of distinct errors across many files
//      are still a lot — but they're all signal (unlike make/npm noise).
//      Deduplication + grouping by file makes the structure scannable.
//
// Strategy:
//   - Keep every distinct diagnostic (file, line, col, code, message).
//   - Drop exact-duplicate adjacent lines (the incremental-build echo).
//   - Keep the `Found N errors in M files.` summary.
//   - Group diagnostics by file for scannability.
//   - Non-diagnostic lines (watch-mode chatter, version banners) are
//     dropped unless they look like errors.
//
// This compressor is LOSSY only in that it drops exact duplicate lines.
// Every distinct diagnostic is preserved verbatim.

import type { Compressor } from "../types.ts";

// A tsc diagnostic line:
//   `path/file.ts(12,5): error TS2322: Type 'string' is not assignable...`
//   `path/file.ts(12,5): warning TS...: ...`
//   `path/file.ts(12): error TS...: ...`  (column omitted)
const DIAG_RE =
  /^(?<file>.+?\.(?:ts|tsx|js|jsx|mts|cts))\((?<loc>\d+(?:,\d+)?)\):\s+(?<severity>error|warning|info)\s+(?<code>TS\d+):\s+(?<msg>.*)$/;

// The summary line: `Found 24 errors in 6 files.`
const SUMMARY_RE = /^Found\s+\d+\s+errors?\s+in\s+\d+\s+files?\./;

// tsc watch-mode noise: `10:01:23 - File change detected...`,
// `10:01:24 - Starting compilation in watch mode...`, etc.
const WATCH_NOISE_RE = /^\d{2}:\d{2}:\d{2}\s+-\s+/;

// Version banner: `Version 5.4.5`
const VERSION_RE = /^Version\s+\d/;

interface Diag {
  file: string;
  loc: string;
  severity: string;
  code: string;
  msg: string;
  raw: string;
}

export const tscCompressor: Compressor = {
  name: "tsc",
  category: "build-tool",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `tsc`, `tsc --noEmit`, `tsc -b`, `npx tsc`, `yarn tsc`, `pnpm tsc`
    // but NOT `tsc.umd.js` or paths containing tsc as a substring.
    return /^(?:npx\s+|yarn\s+|pnpm\s+|bunx\s+)?tsc(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const diags: Diag[] = [];
    const summary: string[] = [];
    let duplicatesDropped = 0;
    let noiseDropped = 0;
    let lastRaw = "";

    for (const line of lines) {
      // Summary line — always keep.
      if (SUMMARY_RE.test(line)) {
        summary.push(line.trim());
        lastRaw = "";
        continue;
      }
      const m = line.match(DIAG_RE);
      if (m && m.groups) {
        // Drop exact-duplicate adjacent diagnostics (incremental echo).
        if (line === lastRaw) {
          duplicatesDropped++;
          continue;
        }
        diags.push({
          file: m.groups.file!,
          loc: m.groups.loc!,
          severity: m.groups.severity!,
          code: m.groups.code!,
          msg: m.groups.msg!,
          raw: line,
        });
        lastRaw = line;
        continue;
      }
      // Watch-mode / version noise — drop.
      if (WATCH_NOISE_RE.test(line) || VERSION_RE.test(line)) {
        noiseDropped++;
        lastRaw = "";
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        lastRaw = "";
        continue;
      }
      // Unknown line — keep only if it looks like an error (defensive).
      if (/\b(error|cannot find|failed)\b/i.test(line)) {
        diags.push({
          file: "",
          loc: "",
          severity: "error",
          code: "",
          msg: line.trim(),
          raw: line,
        });
        lastRaw = "";
        continue;
      }
      noiseDropped++;
      lastRaw = "";
    }

    // If we found nothing meaningful, return raw.
    if (diags.length === 0 && summary.length === 0) return raw;

    // Group diagnostics by file for scannability.
    const byFile = new Map<string, Diag[]>();
    for (const d of diags) {
      const f = d.file || "<unknown>";
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f)!.push(d);
    }

    const out: string[] = [];
    if (summary.length > 0) {
      out.push(summary.join("; "));
    }
    if (diags.length > 0) {
      out.push("");
      out.push(`${diags.length} diagnostic(s) in ${byFile.size} file(s):`);
      // Sort files alphabetically for deterministic output.
      const files = [...byFile.keys()].sort();
      for (const f of files) {
        const ds = byFile.get(f)!;
        out.push("");
        out.push(`${f}:`);
        for (const d of ds) {
          // Re-emit in the canonical tsc format (deduped).
          if (d.code) {
            out.push(
              `  (${d.loc}): ${d.severity} ${d.code}: ${d.msg}`,
            );
          } else {
            out.push(`  ${d.msg}`);
          }
        }
      }
    }
    if (duplicatesDropped > 0) {
      out.push(`(${duplicatesDropped} duplicate lines dropped)`);
    }
    if (noiseDropped > 0) {
      out.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = out.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
