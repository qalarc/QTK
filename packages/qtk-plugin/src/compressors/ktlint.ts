// `ktlint` compressor.
//
// KtLint (`ktlint` / `ktlint src/`) is a Kotlin linter/formatter. Its default
// output emits findings one per line:
//
//   src/main/kotlin/com/example/App.kt:10:1: File name 'App.kt' should conform
//     to the corresponding class name 'Main'
//   src/main/kotlin/com/example/App.kt:15:5: Class name should be PascalCase
//   src/main/kotlin/com/example/Service.kt:8:1: Import must be ordered
//   src/main/kotlin/com/example/Service.kt:42:80: Exceeded max line length (100)
//   src/main/kotlin/com/example/Handler.kt:20:1: Unexpected indentation (4
//     instead of 2)
//
//   Summary errorCount=0 penalty=0 (no corrections necessary)
//   -- OR --
//   Summary errorCount=5 penalty=5 (5 errors need correction)
//
// KtLint also supports `--reporter=plain` (the default), `--reporter=json`
// (a JSON array of issue objects), and `--reporter=checkstyle` (XML). We detect
// and parse the JSON reporter too.
//
// The signal lives in:
//   - The `file:LINE:COL: message` finding lines. KtLint rule codes are
//     usually NOT in the default output (the message is human-readable), but
//     the location + message are actionable.
//   - The continuation lines for wrapped messages (indented, no leading path —
//     they complete the preceding finding).
//   - The `Summary errorCount=N penalty=M (...)` line.
//
// The bulk that CAN be compressed:
//   - The version banner (ktlint prints its version on some invocations).
//   - The decorative blank-line separators.
//   - The `Checking ...` / `Linting ...` progress lines (when run in verbose
//     mode).
//
// Strategy: keep finding lines, their continuations, and the summary; drop the
// version banner and progress lines. This mirrors the eslint/ruff pattern (lint
// findings — drop the runner chatter).
//
// This compressor is LOSSY: it drops the version banner and progress lines. It
// is NOT reversible. Every finding (file + line + col + message) and the
// summary are preserved.

import type { Compressor } from "../types.ts";

// JSON mode: ktlint `--reporter=json` emits a JSON array of issue objects.
// We detect it by sniffing for a leading `[` where the content includes
// `"file":` or `"message":`.
const JSON_ARRAY_RE = /^\s*\[[\s\S]*"(file|message|rule)"\s*:/;

// Finding line: `file:LINE:COL: message`. The file is a `.kt`/`.kts` path.
// Keep. We anchor on `path.kt(:s)?:NUM:NUM:` to avoid matching arbitrary text.
const FINDING_RE = /^[\w./@-]+\.kts?:\d+:\d+:\s+\S/;

// Continuation line: indented text with no leading path. KtLint wraps long
// messages onto the next line, indented. Keep — it completes the preceding
// finding. We require leading whitespace + non-space content.
const CONTINUATION_RE = /^\s+\S/;

// Summary: `Summary errorCount=N penalty=M (...)`. Keep.
const SUMMARY_RE = /^Summary\s+errorCount=/i;

// Version banner: `ktlint 1.x.x` / `ktlint: version ...`. Drop.
const VERSION_RE = /^ktlint[:\s]+\d+\.\d+/i;

// Progress lines: `Checking ...` / `Linting ...` / `Formatting ...`. Drop.
const PROGRESS_RE = /^(Checking|Linting|Formatting|Processing)\s+/i;

export const ktlintCompressor: Compressor = {
  name: "ktlint",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `ktlint`, `ktlint src/`, `ktlint --reporter=plain`, `ktlint test`.
    // EXCLUDE `ktlint --version`, `ktlint --help`, `ktlint --apply-to-idea`
    // (IDE config generation), `ktlint install`.
    if (/^ktlint\s+--?version\b/.test(cmd)) return false;
    if (/^ktlint\s+--?help\b/.test(cmd)) return false;
    if (/^ktlint\s+--apply-to-idea\b/.test(cmd)) return false;
    if (/^ktlint\s+install\b/.test(cmd)) return false;
    // EXCLUDE `ktlint -F` / `ktlint --format` (that MUTATES files — its output
    // is a fix report, not a lint report).
    if (/^ktlint\s+(-F|--format)\b/.test(cmd)) return false;
    return /^ktlint\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    // JSON mode: parse the structured output and re-emit a compact text form.
    if (JSON_ARRAY_RE.test(raw)) {
      return compressJson(raw);
    }

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    let sawFinding = false;

    for (const line of lines) {
      // Finding line — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        sawFinding = true;
        continue;
      }
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Progress lines — drop.
      if (PROGRESS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Continuation line (only meaningful after a finding) — keep.
      if (sawFinding && CONTINUATION_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|fatal)\b/i.test(line)) {
        kept.push(line);
        continue;
      }
      noiseDropped++;
    }

    // If we found nothing meaningful, return raw.
    if (kept.length === 0) return raw;

    if (noiseDropped > 0) {
      kept.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = kept.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};

/**
 * Parse ktlint `--reporter=json` output and re-emit a compact text form.
 *
 * Shape: a JSON array of objects:
 *   [
 *     {
 *       "file": "src/main/kotlin/com/example/App.kt",
 *       "errors": [
 *         { "line": 10, "column": 1, "message": "File name ...", "rule": "filename" },
 *         ...
 *       ]
 *     },
 *     ...
 *   ]
 *
 * On any parse error, return `raw` unchanged (the cardinal rule).
 */
function compressJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // malformed JSON — pass through unchanged
  }
  if (!Array.isArray(parsed)) return raw;

  const out: string[] = [];
  let total = 0;

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file : "?";
    const errors = e.errors;
    if (!Array.isArray(errors)) continue;
    for (const err of errors) {
      if (typeof err !== "object" || err === null) continue;
      const o = err as Record<string, unknown>;
      const line = typeof o.line === "number" ? o.line : "?";
      const col = typeof o.column === "number" ? o.column : 0;
      const message = typeof o.message === "string" ? o.message : "";
      const rule = typeof o.rule === "string" ? ` (${o.rule})` : "";
      out.push(`${file}:${line}:${col}: ${message}${rule}`);
      total++;
    }
  }

  if (out.length > 0) {
    out.push(`Summary errorCount=${total} penalty=${total} (${total} errors need correction)`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}
