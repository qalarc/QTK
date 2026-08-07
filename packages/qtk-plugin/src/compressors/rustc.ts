// `rustc` compressor.
//
// Direct `rustc` invocation (`rustc foo.rs`) emits compiler diagnostics in a
// distinctive multi-line format per error/warning:
//
//   error[E0308]: mismatched types
//     --> src/main.rs:13:5
//      |
//   13 |     let x: i32 = "hello";
//      |                  ^^^^^^^ expected `i32`, found `&str`
//      |
//   help: consider removing the string literal
//      |
//   13 -     let x: i32 = "hello";
//   13 +     let x: i32 = 42;
//      |
//
//   warning: unused variable: `x`
//    --> src/main.rs:4:9
//     |
//   4 |     let x = 5;
//     |         ^ help: if this is intentional, prefix with an underscore: `_x`
//     |
//     = note: `#[warn(unused_variables)]` on by default
//
//   error: aborting due to 2 previous errors
//
// The signal lives in:
//   - `error[E0xxx]:` / `warning:` diagnostic headers (with the lint/error code).
//   - The `--> file.rs:LINE:COL` span locator.
//   - The source snippet + the `|` underline (`^^^` pointing at the column).
//   - `note:` / `help:` / `= note:` continuation lines (explanations + fixes).
//   - The `error: aborting due to N previous errors` summary.
//   - `warning:` lines with `#[warn(...)]` lint codes.
//
// The bulk that CAN be compressed:
//   - The version banner (`rustc 1.xx.0 (...)`) printed on some invocations.
//   - The decorative `|` border lines (the standalone `|` lines that frame the
//     snippet but carry no information beyond alignment).
//   - Exact-duplicate adjacent diagnostics (rare, but rustc sometimes emits
//     the same error twice during incremental compilation).
//
// Strategy: keep diagnostic headers, span locators, source snippets, under-
// lines, note/help continuations, and the abort summary; drop version banners
// and collapse consecutive blank lines. Deduplicate exact-adjacent identical
// diagnostic blocks (same `error[E0xxx]:` header + span).
//
// NOTE: this compressor targets DIRECT `rustc` invocation, NOT `cargo build`
// / `cargo check` (cargo wraps rustc and adds its own framing — the cargo
// compressor handles that). This is niche but distinctive: a user running
// `rustc foo.rs` directly gets raw rustc diagnostics.
//
// This compressor is LOSSY: it drops version banners and collapses blank
// separators. It is NOT reversible. Every diagnostic (error code + message +
// span + source + underline + note/help) is preserved.

import type { Compressor } from "../types.ts";

// `error[E0xxx]:` / `warning:` / `error:` diagnostic header. Keep.
// Matches `error[E0308]: msg`, `warning: msg`, `warning: unused ...`,
// `error: aborting due to ...`.
const DIAG_HEADER_RE =
  /^(error|warning)(\[[EeWw]\d{4}\])?:\s+.+/;

// `error: aborting due to N previous errors` — the abort summary. Keep.
const ABORT_RE = /^error:\s+aborting due to/;

// `  --> src/main.rs:13:5` — span locator. Keep.
const SPAN_RE = /^\s*-->\s+[\w./-]+:\d+:\d+/;

// Source line inside a diagnostic: `  13 |     let x: i32 = ...`. Keep.
// Format: optional indent, line number, ` | `, then the source.
const SOURCE_LINE_RE = /^\s*\d+\s+\|/;

// Underline / caret line: `   |     ^^^ expected ...`. Keep.
// Format: optional indent, ` |`, then carets/spaces + optional message.
const UNDERLINE_RE = /^\s*\|\s*[\^~]/;

// `  |` — standalone border line (just a pipe, framing the snippet). Drop.
// This is the decorative `|` that appears on its own line above/below the
// source line. We distinguish it from the underline line (which has `^^^`).
const BORDER_PIPE_RE = /^\s*\|\s*$/;

// `  = note:` / `  = help:` — continuation note/help. Keep.
const NOTE_HELP_RE = /^\s*=\s+(note|help):/;

// `  help:` — help suggestion (without the `=` prefix). Keep.
const HELP_RE = /^\s*help:/;

// `rustc 1.xx.0 (...)` — version banner. Drop.
const VERSION_RE = /^rustc\s+\d+\.\d+/;

// Suggestion diff line: `  13 -     old` / `  13 +     new`. Keep (part of help).
const SUGGESTION_RE = /^\s*\d+\s+[-+]/;

export const rustcCompressor: Compressor = {
  name: "rustc",
  category: "compiler",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `rustc foo.rs`, `rustc --edition 2021 foo.rs`. EXCLUDE `rustc --version`
    // (not a compile run), `rustc --print` (sysroot info).
    if (/^rustc\s+--(version|print)/.test(cmd)) return false;
    return /^rustc(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inDiag — inside a diagnostic block (after a header). We keep
    // span locators, source lines, underlines, note/help, and suggestion lines
    // while inside a block. A blank line ends the block.
    let inDiag = false;
    // Track the last diagnostic header for adjacent-dedup.
    let lastHeader = "";

    for (const line of lines) {
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Diagnostic header — keep (with adjacent dedup).
      if (DIAG_HEADER_RE.test(line) || ABORT_RE.test(line)) {
        // Deduplicate exact-adjacent identical headers (same error twice).
        if (line === lastHeader && inDiag) {
          noiseDropped++;
          continue;
        }
        lastHeader = line;
        kept.push(line);
        inDiag = true;
        continue;
      }
      // Inside a diagnostic block.
      if (inDiag) {
        // Blank line ends the block.
        if (line.trim() === "") {
          inDiag = false;
          continue;
        }
        // Span locator — keep.
        if (SPAN_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Source line (`  N | source`) — keep.
        if (SOURCE_LINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Underline (`  | ^^^ msg`) — keep.
        if (UNDERLINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Note/help continuation (`  = note:` / `  = help:`) — keep.
        if (NOTE_HELP_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Help suggestion (`  help:`) — keep.
        if (HELP_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Suggestion diff line (`  N - old` / `N + new`) — keep.
        if (SUGGESTION_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Standalone border pipe (`  |`) — drop (decorative).
        if (BORDER_PIPE_RE.test(line)) {
          noiseDropped++;
          continue;
        }
        // Other indented content inside a diag block — keep defensively.
        if (/^\s+/.test(line)) {
          kept.push(line);
          continue;
        }
        // Non-indented, non-blank line ends the block.
        inDiag = false;
        // Fall through to re-evaluate as a potential new header.
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/fatal.
      if (/\b(error|fatal|panic)\b/i.test(line)) {
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
