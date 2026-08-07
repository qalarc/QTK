// `pylint` compressor.
//
// Pylint (`pylint src/` / `python -m pylint .`) emits findings in a compact
// format, grouped by module:
//
//   *************
//   Module src.app
//   src/app.py:10:8: C0103: Class name 'foo' doesn't conform to PascalCase naming style (invalid-name)
//   src/app.py:15:4: W0612: Unused variable 'result' (unused-variable)
//   src/app.py:22:0: E1101: Module 'os' has no 'nonexistent' member (no-member)
//   *************
//   Module src.utils
//   src/utils.py:8:0: C0114: Missing module docstring (missing-module-docstring)
//
//   -------------------------------------------------------------------
//   Your code has been rated at 4.25/10 (raw score: 4.25/10.00)
//
//   Report
//   ======
//   16 statements analysed.
//
// The signal lives in:
//   - The `file.py:LINE:COL: LNNNN: message (symbolic-name)` finding lines.
//     Pylint uses a letter+number code: C=Convention, R=Refactor, W=Warning,
//     E=Error, F=Fatal. The symbolic name in parentheses is the actionable
//     identifier (e.g. `unused-variable`, `no-member`, `line-too-long`).
//   - The `************* Module <name>` headers — useful for grouping findings
//     by module (pylint prints one per module).
//   - The `Your code has been rated at X/10` rating line + the summary.
//
// The bulk that CAN be compressed:
//   - The version banner (`pylint 3.2.0` / `pylint: command line ...`).
//   - The decorative `---` border lines around the rating.
//   - The `Report` / `======` / `N statements analysed.` block (the rating
//     line already captures the outcome; the statement count is low-value).
//   - Watch-mode chatter (`Watch mode is enabled`, `Watching for file
//     changes...`, `Press Ctrl-C to exit`).
//   - The long `--help`-style suggestion lines pylint sometimes prints.
//
// Strategy: keep finding lines, the `************* Module` headers, and the
// rating line; drop the version banner, decorative borders, the Report block,
// and watch-mode chatter. This mirrors the ruff/eslint/mypy pattern (Python
// lint with codes — drop the decorative epilogue).
//
// This compressor is LOSSY: it drops the version banner, decorative borders,
// the Report block, and watch-mode chatter. It is NOT reversible. Every
// finding (code + symbolic name + message + file + line + col), the module
// headers, and the rating are preserved.

import type { Compressor } from "../types.ts";

// Finding line: `file.py:LINE:COL: LNNNN: message (symbolic-name)`.
// The code is a letter (C/R/W/E/F) + 4 digits. Path may contain `\` (Windows)
// or `/`, and may contain `:`, so we anchor on the `:NUM:NUM: LNUM:` suffix.
// Keep.
const FINDING_RE = /^[^:]+:\d+:\d+:\s+[CRWEF]\d{4}:/;

// Module header: `************* Module src.app`. Keep (groups findings).
const MODULE_HEADER_RE = /^\*+\s+Module\s+\S/;

// Rating line: `Your code has been rated at X/10`. Keep.
const RATING_RE = /^Your code has been rated at\s+/;

// Version banner: `pylint 3.2.0` / `pylint: ...`. Drop.
const VERSION_RE = /^pylint[:\s]/;

// Decorative border: `---...` / `===...` / `***...` (without `Module`).
// Drop. (The `************* Module` header is matched first by MODULE_HEADER_RE.)
const BORDER_RE = /^[-=*]{3,}$/;

// Report block header: `Report`. Drop.
const REPORT_RE = /^Report\s*$/;

// Watch-mode chatter. Drop.
const WATCH_RE = /^(Watch(ing| mode)|Press Ctrl-C)/;

// `N statements analysed.` — part of the Report block. Drop.
const STATEMENTS_RE = /^\d+\s+statements?\s+analysed/i;

export const pylintCompressor: Compressor = {
  name: "pylint",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `pylint src/`, `pylint .`, `python -m pylint .`, `pylint --disable=C0114 src/`.
    // EXCLUDE `pylint --version` (not a lint run).
    if (/^pylint\s+--version/.test(cmd)) return false;
    if (/^python\s+-m\s+pylint\s+--version/.test(cmd)) return false;
    return /^(pylint|python\s+-m\s+pylint)\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // Finding line — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Module header — keep.
      if (MODULE_HEADER_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Rating line — keep.
      if (RATING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Report block header — drop.
      if (REPORT_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `N statements analysed.` — drop.
      if (STATEMENTS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Watch-mode chatter — drop.
      if (WATCH_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Decorative border — drop.
      if (BORDER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|traceback)\b/i.test(line)) {
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
