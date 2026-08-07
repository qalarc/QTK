// `psalm` compressor.
//
// Psalm (`psalm` / `vendor/bin/psalm` / `psalm src/`) is a PHP static analysis
// tool. Its default output emits findings one per line:
//
//   Target PHP version: 8.1 (inferred from composer.json)
//   Scanning files...
//   Analyzing files...
//
//   -----------------------------
//   Psalm 5.20.0@3c47cd0569cc1a5a3a4e92353f02e9c9f06a15d9
//   -----------------------------
//
//   To fix the errors found, run Psalm with the flag --alter --issues=all
//
//   ERROR: UndefinedClass - src/App.php:10:5 - Class App not found (see ...
//   ERROR: NullArgument - src/Service/UserService.php:42:23 - Argument 1 of
//     App\Service\UserService::find(int $id) cannot be null, expecting int
//   ERROR: PossiblyNullReference - src/Controller/AuthController.php:8:10 -
//     Cannot call method login() on possibly null value of type App\User|null
//   INFO: MissingReturnType - src/Handler.php:15 - Method App\Handler::process
//     does not have a return type, expecting void
//
//   ----------------------------
//   4 errors found
//   ----------------------------
//
//   To fix the errors found, run Psalm with the flag --alter --issues=all
//
// Psalm also supports `--output-format=json` (a JSON array of issue objects)
// and `--output-format=text` (the default). We detect and parse JSON too.
//
// The signal lives in:
//   - The `SEVERITY: IssueType - file:LINE:COL - message` finding lines.
//     Severity is `ERROR` / `WARNING` / `INFO` / `SUPPRESSED`. The issue type
//     (UndefinedClass, NullArgument, ...) + the location + the message are all
//     actionable.
//   - The continuation lines for wrapped messages (indented, no leading
//     severity — they complete the preceding finding).
//   - The `N errors found` / `N errors and M warnings found` summary.
//
// The bulk that CAN be compressed:
//   - The version banner (`Psalm X.Y.Z@hash` + the `---` borders around it).
//   - The `Target PHP version: ...` line.
//   - The `Scanning files...` / `Analyzing files...` progress lines.
//   - The `To fix the errors found, run Psalm with --alter ...` hint (it
//     repeats verbatim and is derivable from the issue types).
//   - The decorative `---` borders.
//
// Strategy: keep finding lines, their continuations, and the summary; drop the
// version banner, progress lines, the `--alter` hint, and decorative borders.
// This mirrors the phpstan/mypy pattern (static analysis with file:line
// findings — drop the runner chatter).
//
// This compressor is LOSSY: it drops the version banner, progress lines, the
// `--alter` hint, and decorative borders. It is NOT reversible. Every finding
// (severity + issue type + file + line + col + message) and the summary are
// preserved.

import type { Compressor } from "../types.ts";

// JSON mode: Psalm `--output-format=json` emits a JSON array of issue objects.
// We detect it by sniffing for a leading `[` (possibly after whitespace) where
// the content includes `"type":"` or `"severity":"`.
const JSON_ARRAY_RE = /^\s*\[[\s\S]*"(type|severity)"\s*:/;

// Finding line: `SEVERITY: IssueType - file:LINE:COL - message`. Severity is
// ERROR / WARNING / INFO / SUPPRESSED. The issue type is a CamelCase word.
// Keep. We anchor on `SEVERITY: Word - path:NUM(:NUM)? -`.
const FINDING_RE =
  /^\s*(ERROR|WARNING|INFO|SUPPRESSED|MIXED):\s+\S+\s+-\s+\S+:\d+(?::\d+)?\s+-\s+/;

// Continuation line: indented text with no leading severity. Psalm wraps long
// messages onto the next line, indented. Keep — it completes the preceding
// finding. We require leading whitespace + non-space content.
const CONTINUATION_RE = /^\s+\S/;

// Summary: `N errors found` / `N errors and M warnings found` / `No errors
// found!`. Keep.
const SUMMARY_RE = /^\s*(\d+\s+errors?(\s+and\s+\d+\s+warnings?)?\s+found|No\s+errors?\s+found)/;

// Version banner: `Psalm X.Y.Z@hash`. Drop.
const VERSION_RE = /^Psalm\s+\d+\.\d+\.\d+/;

// `Target PHP version: ...`. Drop.
const TARGET_RE = /^Target\s+PHP\s+version\b/;

// Progress lines: `Scanning files...` / `Analyzing files...`. Drop.
const PROGRESS_RE = /^(Scanning|Analyzing|Checking)\s+\w/i;

// `To fix the errors found, run Psalm with --alter ...` hint. Drop.
const ALTER_HINT_RE = /^To fix the errors?\s+found,/i;

// Decorative border: `---...` / `===...` / `***...`. Drop.
const BORDER_RE = /^[-=*]{3,}$/;

export const psalmCompressor: Compressor = {
  name: "psalm",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `psalm`, `psalm src/`, `vendor/bin/psalm`, `psalm --no-cache`.
    // EXCLUDE `psalm --version`, `psalm --alter` (that MUTATES files), `psalm
    // --init` (config generation), `psalm --shepherd` (upload), `psalm help`,
    // `psalm --clear-cache`.
    if (/psalm\s+--?version\b/.test(cmd)) return false;
    if (/psalm\s+--alter\b/.test(cmd)) return false;
    if (/psalm\s+--init\b/.test(cmd)) return false;
    if (/psalm\s+--shepherd\b/.test(cmd)) return false;
    if (/psalm\s+help\b/.test(cmd)) return false;
    if (/psalm\s+--clear-cache\b/.test(cmd)) return false;
    // Match `psalm` (bare = analyse) or `vendor/bin/psalm` / `php vendor/bin/psalm`.
    return /(^|[\/\s])psalm(\s|$)/.test(cmd);
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
      // `Target PHP version: ...` — drop.
      if (TARGET_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Progress lines — drop.
      if (PROGRESS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `To fix the errors found, ...` hint — drop.
      if (ALTER_HINT_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Decorative border — drop.
      if (BORDER_RE.test(line)) {
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
 * Parse Psalm `--output-format=json` output and re-emit a compact text form.
 *
 * Shape: a JSON array of objects:
 *   [
 *     {
 *       "severity": "error",
 *       "line_from": 10,
 *       "column_from": 5,
 *       "file_name": "src/App.php",
 *       "type": "UndefinedClass",
 *       "message": "Class App not found"
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
  let errors = 0;

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const severity = typeof o.severity === "string" ? o.severity : "error";
    const type = typeof o.type === "string" ? o.type : "Unknown";
    const file = typeof o.file_name === "string" ? o.file_name : "?";
    const line = typeof o.line_from === "number" ? o.line_from : "?";
    const col = typeof o.column_from === "number" ? o.column_from : 0;
    const message = typeof o.message === "string" ? o.message : "";
    const sevUpper = severity.toUpperCase();
    const colPart = col && col > 0 ? `:${col}` : "";
    out.push(`${sevUpper}: ${type} - ${file}:${line}${colPart} - ${message}`);
    if (sevUpper === "ERROR") errors++;
  }

  if (out.length > 0) {
    out.push(`${errors} errors found`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}
