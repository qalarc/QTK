// `black` compressor.
//
// Black in check mode (`black --check .` / `black --check src/`) emits a list
// of files it would reformat, plus a summary:
//
//   would reformat src/app.py
//   would reformat src/utils.py
//   would reformat src/models.py
//   Oh no! 💥 💔 💥
//   3 files would be reformatted.
//
// On a clean tree:
//   All done! ✨ 🍰 ✨
//   3 files left unchanged.
//
// The signal lives in:
//   - The `would reformat <file>` lines — files that need formatting (the
//     actionable list; the fix is `black <file>`).
//   - The `N files would be reformatted.` summary.
//   - The `error: cannot format <file>: <message>` lines — files black could
//     not parse.
//
// The bulk that CAN be compressed:
//   - The version banner (`black, 24.1.0` / `black 24.1.0` — printed to stderr
//     on some setups, or with `--version`).
//   - The clean-pass chatter (`All done! ✨ 🍰 ✨` — emojis + celebration) and
//     the `N files left unchanged.` line (low-value on a clean tree).
//   - The `Oh no! 💥 💔 💥` decorative line (emojis, no information — the
//     summary count already says how many files).
//   - The `reformatted <file>` lines from a non-check run (those only appear
//     with `black .` without `--check`, which mutates files — we exclude that
//     invocation, but the line shape can still leak into CI logs).
//
// Strategy: keep `would reformat`/`error: cannot format` file lines + the
// `N files would be reformatted.` summary; drop the version banner, the
// emoji-laden clean-pass chatter, the `Oh no!` decoration, and `N files left
// unchanged.`. This mirrors the prettier/eslint pattern (formatter check —
// keep the file list + summary, drop the decorative epilogue).
//
// This compressor is LOSSY: it drops the version banner, the emoji clean-pass
// chatter (`All done! ✨ 🍰 ✨`), the `Oh no! 💥 💔 💥` line, and the
// `N files left unchanged.` summary. It is NOT reversible. Every non-conforming
// file (`would reformat` / `error:`) and the reformat summary count are
// preserved.

import type { Compressor } from "../types.ts";

// `would reformat <file>` — a file that needs formatting. Keep.
const WOULD_REFORMAT_RE = /^would reformat\s+\S/;

// `error: cannot format <file>: <message>` — a file black could not parse. Keep.
const ERROR_RE = /^error:\s+cannot format\s+/;

// Summary: `N files would be reformatted.`. Keep.
const SUMMARY_RE = /^\d+\s+files?\s+would be reformatted\./;

// Version banner: `black, 24.1.0` / `black 24.1.0`. Drop.
const VERSION_RE = /^black[,,:]?\s+v?\d/;

// Clean-pass chatter: `All done! ✨ 🍰 ✨`. Drop (emojis + celebration).
const CLEAN_RE = /^All done!/;

// `N files left unchanged.` — clean-tree summary. Drop (low-value).
const UNCHANGED_RE = /^\d+\s+files?\s+left unchanged\./;

// `Oh no! 💥 💔 💥` — decorative. Drop.
const OH_NO_RE = /^Oh no!/;

// `reformatted <file>` — from a non-check (mutating) run. Drop (leak).
const REFORMATTED_RE = /^reformatted\s+\S/;

export const blackCompressor: Compressor = {
  name: "black",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `black --check .`, `black --check src/`, `python -m black --check .`.
    // EXCLUDE `black --version` (not a check run) and bare `black .` (that
    // MUTATES files — its output is `reformatted <file>`, a different shape).
    if (/black\s+--version/.test(cmd)) return false;
    // Match only when --check is present (read-only check mode).
    return /(^|\s)black\s+.*--check/.test(cmd) ||
      /(^|\s)python\s+-m\s+black\s+.*--check/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // `would reformat <file>` — keep.
      if (WOULD_REFORMAT_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `error: cannot format <file>: <message>` — keep.
      if (ERROR_RE.test(line)) {
        kept.push(line);
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
      // Clean-pass chatter — drop.
      if (CLEAN_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `N files left unchanged.` — drop.
      if (UNCHANGED_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `Oh no!` decoration — drop.
      if (OH_NO_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `reformatted <file>` (mutating-run leak) — drop.
      if (REFORMATTED_RE.test(line)) {
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

    // Only emit the noise-dropped suffix when it doesn't eat the savings.
    // Black --check output is already terse, so the suffix would make the
    // output LARGER than the input on small runs.
    if (noiseDropped > 1) {
      kept.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = kept.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
