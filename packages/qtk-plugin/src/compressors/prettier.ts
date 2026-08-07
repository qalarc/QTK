// `prettier` compressor.
//
// Prettier in check mode (`prettier --check .` / `npx prettier --check src/`)
// emits a list of files whose formatting does NOT conform, plus a summary:
//
//   Checking formatting...
//   [warn] src/app.ts
//   [warn] src/utils.ts
//   [warn] Code style issues found in 2 files. Forgot to run Prettier?
//   [error] src/broken.ts: SyntaxError: Unexpected token (5:10)
//   All matched files use Prettier code style!   <- clean-pass chatter (dropped)
//
// The signal lives in:
//   - The `[warn] <file>` lines — files that need formatting (the actionable
//     list; the fix is `prettier --write <file>`).
//   - The `[error] <file>: <message>` lines — files prettier could not even
//     parse (syntax errors).
//   - The `Code style issues found in N files.` summary line.
//
// The bulk that CAN be compressed:
//   - The `Checking formatting...` progress line.
//   - The clean-pass chatter (`All matched files use Prettier code style!`).
//   - Version banners (`prettier/x.y.z` — only printed with `--version`, but
//     sometimes leaks into CI logs).
//   - The `Forgot to run Prettier?` tail of the summary (it's a hint, not a
//     fact — but it lives on the same line as the count, so we keep the whole
//     summary line intact for fidelity).
//
// Strategy: keep `[warn]`/`[error]` file lines + the `Code style issues found`
// summary; drop the progress line, clean-pass chatter, and version banner.
// This mirrors the eslint/ruff pattern (lint findings — drop the decorative
// epilogue).
//
// This compressor is LOSSY: it drops the `Checking formatting...` progress
// line, the clean-pass chatter, and version banners. It is NOT reversible.
// Every non-conforming file (`[warn]`/`[error]`) and the summary count are
// preserved.

import type { Compressor } from "../types.ts";

// `[warn] <file>` — a file that needs formatting. Keep.
// Prettier prints the path verbatim (relative or absolute, any extension).
const WARN_RE = /^\[warn\]\s+\S/;

// `[error] <file>: <message>` — a file prettier could not parse. Keep.
const ERROR_RE = /^\[error\]\s+\S/;

// Summary: `Code style issues found in N files. Forgot to run Prettier?`. Keep.
const SUMMARY_RE = /^Code style issues? found in\s+/;

// Progress line: `Checking formatting...`. Drop.
const PROGRESS_RE = /^Checking formatting\.\.\./;

// Clean-pass chatter: `All matched files use Prettier code style!`. Drop.
const CLEAN_RE = /^All matched files use Prettier code style!/;

// Version banner: `prettier/x.y.z` / `prettier x.y.z`. Drop.
const VERSION_RE = /^prettier[\/: ]\s*v?\d/;

export const prettierCompressor: Compressor = {
  name: "prettier",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `prettier --check .`, `npx prettier --check src/`, `prettier -c .`.
    // EXCLUDE `prettier --version` (not a check run) and `prettier --write`
    // (that MUTATES files — its output is the file list, not a check report).
    if (/prettier\s+--version/.test(cmd)) return false;
    if (/prettier\s+--write/.test(cmd)) return false;
    if (/prettier\s+-w\b/.test(cmd)) return false;
    // Match `prettier --check` / `prettier -c` (the check flag is required).
    return /(^|\s)prettier\s+.*(--check|-c\b)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // `[warn] <file>` — keep.
      if (WARN_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `[error] <file>: <message>` — keep.
      if (ERROR_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Progress line — drop.
      if (PROGRESS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Clean-pass chatter — drop.
      if (CLEAN_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed)\b/i.test(line)) {
        kept.push(line);
        continue;
      }
      noiseDropped++;
    }

    // If we found nothing meaningful, return raw.
    if (kept.length === 0) return raw;

    // Only emit the noise-dropped suffix when it doesn't eat the savings.
    // Prettier --check output is already terse (often just 1 progress line of
    // noise), so the suffix would make the output LARGER than the input.
    if (noiseDropped > 1) {
      kept.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = kept.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
