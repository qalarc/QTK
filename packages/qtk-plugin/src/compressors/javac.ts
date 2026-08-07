// `javac` compressor.
//
// NOTE: this compressor targets DIRECT `javac` invocation (`javac Main.java`,
// `javac -d out src/*.java`), NOT `gradle`/`./gradlew` or `mvn` (those wrap
// javac and add their own framing — the gradle/mvn compressors handle those).
// This handles a bare `javac` whose output is the raw compiler diagnostic
// stream.
//
// Direct javac diagnostics look like:
//
//   Main.java:5: error: ';' expected
//       int count = 0
//                    ^
//   Main.java:8: error: cannot find symbol
//       symbol:   variable missingVar
//       location: class Main
//       return missingVar;
//              ^
//   Main.java:12: warning: [removal] Integer(int) in Integer has been
//       deprecated and marked for removal
//       Integer val = new Integer(42);
//                     ^
//   Main.java:3: error: method process in class Main cannot be applied to
//       given types;
//     required: int
//     found:    String
//     reason: argument mismatch; String cannot be converted to int
//       process("hello");
//              ^
//   Note: Main.java uses or overrides a deprecated API.
//   Note: Recompile with -Xlint:deprecation for details.
//   Note: Main.java uses unchecked or unsafe operations.
//   Note: Recompile with -Xlint:unchecked for details.
//   3 errors
//   2 warnings
//
// The signal lives in:
//   - The `file.java:LINE: error:/warning: msg` diagnostic headers (severity +
//     message + location are all actionable).
//   - The `symbol:` / `location:` / `required:` / `found:` / `reason:`
//     continuation lines (the "cannot find symbol" / type-mismatch detail
//     block — these pin the exact symbol and expected/found types).
//   - The source-snippet line (the raw source line, indented under the header)
//     and the caret underline (`^` pointing at the column).
//   - The `Note: ...` lines (deprecated-API / unchecked-operation notices).
//   - The `N errors` / `N warnings` summary.
//
// The bulk that CAN be compressed:
//   - The `Picked up _JAVA_OPTIONS` / `Picked up JAVA_TOOL_OPTIONS` noise
//     (JVM startup banner, printed by the launcher before javac runs).
//   - The version banner (`javac 17.0.10` — only with `-version`, but can
//     leak into CI logs).
//   - The `warning: [options] ...` driver-level option warnings that aren't
//     tied to a source location (rare).
//
// Strategy: keep diagnostic headers, the symbol/location/required/found/reason
// detail block, source snippets, underlines, `Note:` lines, and the
// `N errors`/`N warnings` summary; drop the `_JAVA_OPTIONS` noise and version
// banners. This mirrors the gcc/rustc pattern (compiler diagnostics with
// file:line + source snippets). Adjacent identical diagnostics are
// deduplicated.
//
// This compressor is LOSSY: it drops the `_JAVA_OPTIONS` startup noise and
// version banners. It is NOT reversible. Every diagnostic (severity + message
// + file + line + the symbol/type detail) and the summary are preserved.

import type { Compressor } from "../types.ts";

// Diagnostic header: `file.java:LINE: error:/warning: msg`. Path may contain
// `/`, `.`, `-`, `_`. Keep.
const DIAG_HEADER_RE = /^[\w./-]+\.java:\d+:\s+(error|warning):\s+/;

// Detail-block continuation lines: `symbol:`, `location:`, `required:`,
// `found:`, `reason:`. These are the "cannot find symbol" / type-mismatch
// explanation. Keep.
const DETAIL_RE = /^\s+(symbol|location|required|found|reason):/;

// Caret underline: `  ^` — carets pointing at the column, indented. Keep.
const UNDERLINE_RE = /^\s+\^/;

// `Note:` lines (deprecated/unchecked API notices). Keep.
const NOTE_RE = /^Note:/;

// Summary: `N errors` / `N warnings` (javac prints these at the end). Keep.
const SUMMARY_RE = /^\d+\s+(error|warning)s?$/;

// `Picked up _JAVA_OPTIONS` / `Picked up JAVA_TOOL_OPTIONS` — JVM launcher
// noise. Drop.
const JAVA_OPTS_RE = /^Picked up\s+(_JAVA_OPTIONS|JAVA_TOOL_OPTIONS)/;

// Version banner: `javac 17.0.10` / `javac 1.8.0_422`. Drop.
const VERSION_RE = /^javac\s+\d/;

export const javacCompressor: Compressor = {
  name: "javac",
  category: "compiler",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `javac Main.java`, `javac -d out src/*.java`, `javac -cp lib Main.java`.
    // EXCLUDE `javac -version` / `javac --version` (version info, not a
    // compile), `javac -help` / `javac --help` (help text).
    if (/^javac\s+--?version\b/.test(cmd)) return false;
    if (/^javac\s+--?help\b/.test(cmd)) return false;
    // EXCLUDE gradle/mvn wrappers — those are handled by their own
    // compressors. A bare `javac` invocation never starts with `gradle`/
    // `./gradlew`/`mvn`, so this is just defensive.
    if (/^(gradle|\.\/gradlew|mvn)\b/.test(cmd)) return false;
    return /^javac(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inDiag — inside a diagnostic block (after a header). We keep
    // detail lines, source lines, and underlines while inside a block. A
    // blank line or a non-matching line ends the block.
    let inDiag = false;
    // Track the last diagnostic header for adjacent-dedup.
    let lastHeader = "";

    for (const line of lines) {
      // `_JAVA_OPTIONS` noise — drop.
      if (JAVA_OPTS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Diagnostic header — keep (with adjacent dedup).
      if (DIAG_HEADER_RE.test(line)) {
        if (line === lastHeader && inDiag) {
          noiseDropped++;
          continue;
        }
        lastHeader = line;
        kept.push(line);
        inDiag = true;
        continue;
      }
      // `Note:` line — keep.
      if (NOTE_RE.test(line)) {
        kept.push(line);
        inDiag = false;
        continue;
      }
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        inDiag = false;
        continue;
      }
      // Inside a diagnostic block.
      if (inDiag) {
        // Blank line ends the block.
        if (line.trim() === "") {
          inDiag = false;
          continue;
        }
        // Detail-block continuation (`symbol:` / `location:` / ...) — keep.
        if (DETAIL_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Caret underline — keep.
        if (UNDERLINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Source line — keep (any non-blank, non-caret, non-detail indented
        // line inside a block is the source snippet; javac prints it indented
        // without a line-number prefix).
        if (/^\s+/.test(line)) {
          kept.push(line);
          continue;
        }
        // Non-indented, non-blank line ends the block.
        inDiag = false;
        // Fall through to re-evaluate.
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/fatal.
      if (/\b(error|fatal|failed)\b/i.test(line)) {
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
