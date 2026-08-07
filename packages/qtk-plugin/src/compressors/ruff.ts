// `ruff` compressor.
//
// Ruff (`ruff check .`) is a fast Python linter. Its default output emits one
// finding per line in a compact format:
//
//   src/app.py:10:5: E999 SyntaxError: invalid syntax
//   src/app.py:15:1: F401 'os' imported but unused
//   src/utils.py:42:80: E501 Line too long (92 > 79 characters)
//   src/models.py:8:11: E711 Comparison to None should be 'cond is None'
//
// Followed by a summary line and an epilogue:
//
//   Found 12 errors.
//   * Can fix: 8 (8 auto-fixable)
//   View the full documentation: https://docs.astral.sh/ruff/rules/E501
//   View documentation for some of these errors: ...
//
// The signal lives in:
//   - The `file.py:LINE:COL: Exxx message` finding lines (the rule code + the
//     message + the location are all actionable).
//   - The `Found N error(s).` summary.
//   - The `* Can fix: N` auto-fixable count (tells the user `--fix` will help).
//
// The bulk that CAN be compressed:
//   - The `View documentation` / `View the full documentation` URL epilogue.
//     These URLs are derivable from the rule codes
//     (`https://docs.astral.sh/ruff/rules/<RULE>`), so they add no value.
//   - The `*` / divider decorations.
//   - Watch-mode chatter (`Watching for changes...`, `Found N errors. [Fixed]`).
//
// Strategy: keep finding lines, the `Found N error(s).` summary, and the
// `* Can fix:` auto-fixable count; drop the documentation URL epilogue and
// decorative dividers. This mirrors the shellcheck pattern (lint findings with
// codes — drop the URL epilogue since it's derivable from the codes).
//
// This compressor is LOSSY: it drops the documentation URL epilogue. It is NOT
// reversible. Every finding (rule code + message + file + line + col) and the
// summary are preserved — the URLs are derivable from the rule codes.

import type { Compressor } from "../types.ts";

// `file.py:LINE:COL: Exxx message` — finding line. Keep.
// The rule code is a letter prefix + digits (E, W, F, C, B, N, S, T, A, D, etc).
// Path may contain `:`, so we anchor on the `:NUM:NUM: CODE` suffix.
const FINDING_RE = /^[\w./-]+\.py:\d+:\d+:\s+[A-Z]\d+\s+/;

// `Found N error(s).` / `Found N errors.` — summary. Keep.
const FOUND_RE = /^Found\s+\d+\s+error/;

// `* Can fix: N (N auto-fixable)` — auto-fixable count. Keep.
const CAN_FIX_RE = /^\*\s+Can fix:/;

// `View documentation ...` / `View the full documentation: ...` — URL epilogue.
// Drop (URLs are derivable from rule codes).
const VIEW_DOC_RE = /^View (the full )?documentation/;

// `*` decorative divider lines. Drop.
const STAR_DIVIDER_RE = /^\*+$/;

// Watch-mode chatter: `Watching for changes...`, `Starting watch...`. Drop.
const WATCH_RE = /^(Watching|Starting watch|Stopped watching)/;

export const ruffCompressor: Compressor = {
  name: "ruff",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `ruff check .`, `ruff check src/`, `ruff check --select E501 .`.
    // Exclude `ruff --version`, `ruff format` (different tool shape), `ruff rule`
    // (rule info lookup, not a lint run).
    if (/^ruff\s+--version/.test(cmd)) return false;
    return /^ruff\s+check(\s|$)/.test(cmd);
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
      // `Found N error(s).` summary — keep.
      if (FOUND_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `* Can fix: N` — keep.
      if (CAN_FIX_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `View documentation` URL epilogue — drop.
      if (VIEW_DOC_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `*` decorative divider — drop.
      if (STAR_DIVIDER_RE.test(line)) {
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
