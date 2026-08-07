// `phpstan` compressor.
//
// PHPStan (`phpstan analyse` / `vendor/bin/phpstan analyse src/`) is a PHP
// static analyzer. Its default output emits findings one per line:
//
//   Note: Using version 1.10.67
//    1/1 [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓] 100%
//
//    1) src/App.php:10: Class App not found.
//    2) src/App.php:15: Cannot access property $name on App|null.
//    3) src/Service/UserService.php:42: Method App\Service\UserService::find()
//       should return App\User but returns App\Model\User|null.
//    4) src/Controller/AuthController.php:8: Cannot call method login() on
//       App\User|null.
//
//    [OK] No errors
//
//   -- OR on failure --
//
//    ✘  [ERROR] Found 4 errors
//
// PHPStan also supports a `--error-format=raw` / `--error-format=table` mode:
//
//   src/App.php:10:    Class App not found.
//   src/Service/UserService.php:42:    Method ... should return App\User ...
//
// And a `--error-format=json` mode (one JSON object per run, with a `files`
// map and per-file `messages` arrays). We detect and parse that too.
//
// The signal lives in:
//   - The `N) file:line: message` finding lines (the numbered list format).
//   - The `file:line:    message` raw/table format lines.
//   - The continuation lines for wrapped messages (indented, no leading
//     number/path — they complete the preceding finding).
//   - The `[OK] No errors` / `[ERROR] Found N errors` summary.
//
// The bulk that CAN be compressed:
//   - The version banner (`Note: Using version X.Y.Z`).
//   - The progress bar (`1/1 [▓▓▓...] 100%`).
//   - The decorative blank-line separators.
//
// Strategy: keep finding lines, their continuations, and the summary; drop the
// version banner, progress bar, and decorative separators. This mirrors the
// mypy/pylint pattern (static analysis with file:line findings — drop the
// runner chatter).
//
// This compressor is LOSSY: it drops the version banner and progress bar. It
// is NOT reversible. Every finding (file + line + message) and the summary are
// preserved.

import type { Compressor } from "../types.ts";

// JSON mode: the whole output is a single JSON object with a top-level `files`
// map. We detect it by sniffing for `{"files":` or `"totals":` at the start.
const JSON_SNIPPET_RE = /^\s*\{[\s\S]*"files"\s*:/;
const JSON_TOTALS_RE = /"totals"\s*:\s*\{/;

// Numbered finding line: `   N) path:LINE: message`. The path is a PHP file
// (`.php`/`.phar`/`.phtml`/`.php5`) but PHPStan can also report on `.inc` and
// other extensions, so we accept any non-space path. Keep.
const NUMBERED_FINDING_RE = /^\s*\d+\)\s+\S+:\d+:\s+/;

// Raw/table finding line: `path:LINE:    message` (no leading number). The
// message is preceded by whitespace padding. Keep. We require a `:NUM:` anchor
// to avoid matching arbitrary `word:word:` text.
const RAW_FINDING_RE = /^\s*[\w./@-]+:\d+:\s+\S/;

// Continuation line: indented text with no leading number/path/colon anchor.
// PHPStan wraps long messages onto the next line, indented. Keep — it
// completes the preceding finding. We require leading whitespace + non-space
// content + NOT matching the finding patterns (checked after those).
const CONTINUATION_RE = /^\s+\S/;

// Summary: `[OK] No errors` / `[ERROR] Found N errors`. Keep.
const SUMMARY_RE = /^\s*[✘✔]?\s*\[(OK|ERROR)\]/;

// Version banner: `Note: Using version X.Y.Z`. Drop.
const VERSION_RE = /^Note:\s+Using version\b/;

// Progress bar: `N/M [▓░...] X%` or `N/M [=>-] X%`. Drop. The bar uses
// block/box-drawing/shade chars; we match the `NUM/NUM [... NUM%` shape.
const PROGRESS_RE = /^\s*\d+\/\d+\s+\[[▓░=>\-\s]+\]\s*\d+%/;

export const phpstanCompressor: Compressor = {
  name: "phpstan",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `phpstan analyse`, `phpstan analyse src/`, `vendor/bin/phpstan analyse`,
    // `phpstan analyse --level=5 src/`. EXCLUDE `phpstan --version`,
    // `phpstan list`, `phpstan help`, `phpstan generate-baseline`.
    if (/phpstan\s+--?version\b/.test(cmd)) return false;
    if (/phpstan\s+list\b/.test(cmd)) return false;
    if (/phpstan\s+help\b/.test(cmd)) return false;
    if (/phpstan\s+generate-baseline\b/.test(cmd)) return false;
    // Match `phpstan analyse` (the analyse subcommand) OR bare `phpstan`
    // (defaults to `analyse`). Allow `vendor/bin/phpstan` / `php vendor/bin/phpstan`.
    return /(^|[\/\s])phpstan(\s+analyse)?(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    // JSON mode: parse the structured output and re-emit a compact text form.
    if (JSON_SNIPPET_RE.test(raw) && JSON_TOTALS_RE.test(raw)) {
      return compressJson(raw);
    }

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    let sawFinding = false;

    for (const line of lines) {
      // Numbered finding line — keep.
      if (NUMBERED_FINDING_RE.test(line)) {
        kept.push(line);
        sawFinding = true;
        continue;
      }
      // Raw/table finding line — keep.
      if (RAW_FINDING_RE.test(line)) {
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
      // Progress bar — drop.
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
 * Parse PHPStan `--error-format=json` output and re-emit a compact text form.
 *
 * Shape:
 *   {
 *     "files": {
 *       "src/App.php": {
 *         "errors": 2,
 *         "messages": [
 *           { "line": 10, "message": "Class App not found.", ... },
 *           ...
 *         ]
 *       },
 *       ...
 *     },
 *     "totals": { "errors": 4, "file_errors": 4 }
 *   }
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
  if (typeof parsed !== "object" || parsed === null) return raw;
  const root = parsed as Record<string, unknown>;
  const files = root.files;
  if (typeof files !== "object" || files === null) return raw;

  const out: string[] = [];
  let total = 0;

  for (const [filePath, info] of Object.entries(files as Record<string, unknown>)) {
    if (typeof info !== "object" || info === null) continue;
    const messages = (info as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (typeof msg !== "object" || msg === null) continue;
      const m = msg as Record<string, unknown>;
      const line = m.line;
      const message = m.message;
      if (typeof message !== "string") continue;
      const lineStr = typeof line === "number" ? String(line) : "?";
      out.push(`${filePath}:${lineStr}: ${message}`);
      total++;
    }
  }

  // Append the totals if present.
  const totals = root.totals;
  if (typeof totals === "object" && totals !== null) {
    const errs = (totals as Record<string, unknown>).errors;
    if (typeof errs === "number") {
      out.push(`[ERROR] Found ${errs} errors`);
    }
  } else if (total > 0) {
    out.push(`[ERROR] Found ${total} errors`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}
