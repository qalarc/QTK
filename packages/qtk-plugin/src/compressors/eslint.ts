// `eslint` compressor.
//
// ESLint (`eslint .` / `npx eslint src/`) emits findings in a compact format:
//
//   src/app.js
//     10:5   error    'x' is not defined           no-undef
//     15:1   error    Unexpected console statement  no-console
//     42:80  warning  Line too long                 max-len
//
//   src/utils.js
//     8:3   error  Expected ';' and instead saw '}'  semi
//
//   ✖ 5 problems (3 errors, 2 warnings)
//     3 errors and 0 warnings potentially fixable with `eslint --fix`.
//
// The signal lives in:
//   - The `file` header lines (bare path on its own line).
//   - The `LINE:COL  severity  message  rule` finding lines.
//   - The `✖ N problems (M errors, K warnings)` summary.
//   - The `N errors ... fixable with eslint --fix` hint.
//
// The bulk that CAN be compressed:
//   - The ESLint version banner (`eslint: v9.x.x` / `<banner>`).
//   - The `` decorative borders (the `╔═══╗` box around the banner).
//   - "View documentation" / rule-info URLs (derivable from the rule code:
//     `https://eslint.org/docs/latest/rules/<rule>`).
//   - Watch-mode chatter (`Watching ...`, `Linting ...`).
//
// Strategy: keep file headers, finding lines, the `✖ N problems` summary, and
// the fixable hint; drop the version banner, decorative borders, documentation
// URLs, and watch-mode chatter. This mirrors the ruff/shellcheck pattern (lint
// findings with codes — drop the URL epilogue since it's derivable from the
// codes).
//
// This compressor is LOSSY: it drops the version banner, decorative borders,
// and documentation URLs. It is NOT reversible. Every finding (rule + message
// + file + line + col) and the summary are preserved — the URLs are derivable
// from the rule codes.

import type { Compressor } from "../types.ts";

// File header: a bare path on its own line (no leading whitespace, no colon at
// the end). ESLint prints the file path, then findings indented beneath it.
// We match paths with common JS/TS extensions. Keep.
const FILE_HEADER_RE = /^[\w./@-]+\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)\s*$/;

// Finding line: `  LINE:COL  severity  message  rule`. The severity is
// `error`/`warning`. Keep. We anchor on the `NUM:NUM  severity` prefix.
const FINDING_RE = /^\s*\d+:\d+\s+(error|warning)\s+/;

// Summary: `✖ N problems (M errors, K warnings)`. Keep.
const SUMMARY_RE = /^✖\s+\d+\s+problems?/;

// Fixable hint: `  N errors and M warnings potentially fixable with eslint --fix`.
// Keep.
const FIXABLE_RE = /^\s*\d+\s+errors?\s+and\s+\d+\s+warnings?\s+.*fixable/;

// Version banner: `eslint: v9.1.0` or `<text>`. Drop.
const VERSION_RE = /^(eslint:?\s+v?\d|<.*>)/;

// Decorative border lines (box-drawing chars). Drop.
const BORDER_RE = /^[╔╗╚╝║═┌┐└┘│─━┃━]+$/;

// Documentation URL: `https://eslint.org/docs/...`. Drop.
const DOC_URL_RE = /^\s*https?:\/\/(eslint\.org|.*eslint)/;

// Watch-mode chatter. Drop.
const WATCH_RE = /^(Watching|Linting|Started|Stopped)/;

export const eslintCompressor: Compressor = {
  name: "eslint",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `eslint .`, `eslint src/`, `npx eslint .`, `eslint --ext .ts src/`.
    // Exclude `eslint --version`, `eslint --init`, `eslint --fix` (that MUTATES
    // files — its output is different), `eslint --print-config`.
    if (/eslint\s+--version/.test(cmd)) return false;
    if (/eslint\s+--init/.test(cmd)) return false;
    if (/eslint\s+--print-config/.test(cmd)) return false;
    // `eslint --fix` is a fix run, not a lint report — but it still emits
    // remaining findings. We DO match it (the output shape is the same).
    return /(^|\s)eslint(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // File header — keep.
      if (FILE_HEADER_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Finding line — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Fixable hint — keep.
      if (FIXABLE_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Decorative border — drop.
      if (BORDER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Documentation URL — drop.
      if (DOC_URL_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Watch-mode chatter — drop.
      if (WATCH_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|panic)\b/i.test(line)) {
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
