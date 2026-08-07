// `mypy` compressor.
//
// Mypy (`mypy .` / `mypy src/`) is a Python static type checker. Its default
// output emits one finding per line:
//
//   src/app.py:10: error: Name 'foo' is not defined  [name-defined]
//   src/app.py:15: error: Argument 1 to "process" has incompatible type
//                   "str"; expected "int"  [arg-type]
//   src/utils.py:42: note: Use --warn-unused-ignores to see ...
//   src/models.py:8: error: Module has no attribute "User"  [attr-defined]
//
// Followed by a summary line:
//
//   Found 5 errors in 2 files (checked 12 source files)
//   Success: no issues found  (0 errors)
//
// The signal lives in:
//   - The `file.py:LINE: error: <msg>  [error-code]` finding lines (the error
//     code + the message + the location are all actionable).
//   - The `note:` continuation lines (mypy prints these as follow-up context
//     for the preceding error — they often contain the fix suggestion).
//   - The `Found N errors in M files` summary.
//   - The `Success: no issues found` line (clear success indicator — kept so
//     the model knows the type check passed cleanly).
//
// The bulk that CAN be compressed:
//   - The version banner (`mypy 1.10.0 (compiled)`).
//   - The `` decorative borders (the `╔═══╗` box around the banner).
//   - "Use --..." hint lines that repeat the same suggestion N times (mypy
//     prints one per finding; the suggestion is derivable from the error code).
//
// Strategy: keep finding lines, `note:` continuations, the `Found N errors`
// summary, and the `Success:` line; drop the version banner, decorative
// borders, and the repetitive `Use --...` hint lines. This mirrors the ruff
// pattern (Python lint with codes — drop the derivable hint epilogue).
//
// This compressor is LOSSY: it drops the version banner, decorative borders,
// and the `Use --...` hint lines. It is NOT reversible. Every finding (error
// code + message + file + line) and the summary are preserved.

import type { Compressor } from "../types.ts";

// `file.py:LINE: error: <msg>  [error-code]` — finding line. Keep.
// The error code is optional (some errors have no code). Path may contain `:`,
// so we anchor on the `:NUM: error:` / `:NUM: note:` suffix.
const FINDING_RE = /^[\w./-]+\.pyi?:\d+:\s+(error|warning|note):/;

// `Found N errors in M files (checked K source files)` — summary. Keep.
const FOUND_RE = /^Found\s+\d+\s+error/;

// `Success: no issues found  (0 errors)` — clean-pass indicator. Keep.
const SUCCESS_RE = /^Success:\s+no\s+issues?\s+found/;

// Version banner: `mypy 1.10.0 (compiled)` / `mypy 1.10.0`. Drop.
const VERSION_RE = /^mypy\s+\d+\.\d+/;

// Decorative border lines (box-drawing chars). Drop.
const BORDER_RE = /^[╔╗╚╝║═┌┐└┘│─━┃━]+$/;

// `Use --warn-unused-ignores to see ...` — repetitive hint. Drop.
// NOTE: mypy prints this as a `note:` continuation, so it appears mid-line
// after `file.py:LINE: note:`. Match anywhere in the line.
const USE_HINT_RE = /Use\s+--\w/;

export const mypyCompressor: Compressor = {
  name: "mypy",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `mypy .`, `mypy src/`, `mypy --strict .`, `python -m mypy .`.
    // Exclude `mypy --version` (not a type check run).
    if (/^mypy\s+--version/.test(cmd)) return false;
    if (/^python\s+-m\s+mypy\s+--version/.test(cmd)) return false;
    return /^(mypy|python\s+-m\s+mypy)\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // `Use --...` hint — drop. (Checked BEFORE the finding/note regex because
      // mypy prints these as `note:` lines, which would otherwise be kept.)
      if (USE_HINT_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Finding line (`file.py:LINE: error:/warning:/note:`) — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `Found N errors` summary — keep.
      if (FOUND_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `Success: no issues found` — keep (clean-pass indicator).
      if (SUCCESS_RE.test(line)) {
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
