// `swiftc` / `swift build` compressor.
//
// NOTE: this compressor targets DIRECT Swift compiler invocation (`swiftc
// main.swift`, `swift build`), NOT `xcodebuild` (which wraps swiftc and adds
// its own framing). This handles bare `swiftc`/`swift build` whose output is
// the raw compiler diagnostic stream.
//
// swiftc diagnostics look like:
//
//   main.swift:5:7: warning: variable 'count' was never used; consider replacing
//                          with '_' or removing it
//   let count = 0
//       ^~~~~
//   main.swift:10:14: error: use of unresolved identifier 'missingVar'
//   return missingVar
//          ^~~~~~~~~~
//   main.swift:3:1: note: 'process' declared here
//   func process(_ x: Double) { }
//   ^
//   main.swift:15:3: error: cannot convert value of type 'String' to expected
//                          argument type 'Int'
//   process("hello")
//   ^       ~~~~~~~
//
//   /path/to/Sources/Foo/bar.swift:20:5: warning: 'forceTry' is deprecated
//
//   <unknown>:0: error: build had 1 command failure
//   error: fatalError
//
// The signal lives in:
//   - The `file.swift:LINE:COL: error:/warning:/note:/remark: msg` diagnostic
//     headers (severity + message + location are all actionable).
//   - The source-snippet lines (the raw source line, indented under the
//     header) and the caret underline (`^~~~` / `~` pointing at the column).
//   - The `<Unknown>:0: error:` / `<unknown>:0: error:` aggregate-failure
//     markers (swiftc prints these when the build driver fails).
//   - The `error: fatalError` / `error: ...` summary lines the build driver
//     emits at the end.
//
// The bulk that CAN be compressed:
//   - The version banner (`Swift version 5.10.1`, `swift-driver version: ...`,
//     `Apple Swift version 5.10`).
//   - The `Compiling <target> (<architecture>)` / `Linking <target>` /
//     `Building <target>` progress lines.
//   - The `Finding <file>` / `Found <file>` / `Considering <file>` /
//     `Module ... compiled` toolchain-discovery noise.
//   - The `warning: ...` driver-level warnings that aren't tied to a source
//     location (e.g. `warning: cannot find ...`).
//   - The `note:` lines that are pure driver hints (rare).
//
// Strategy: keep diagnostic headers, source snippets, underlines, the
// `<Unknown>:0:` aggregate markers, and the trailing `error: ...` driver
// summary; drop version banners, progress chatter, and toolchain-discovery
// noise. This mirrors the gcc/rustc pattern (compiler diagnostics with
// file:line:col + source snippets). Adjacent identical diagnostics are
// deduplicated.
//
// This compressor is LOSSY: it drops version banners, progress lines, and
// toolchain-discovery noise. It is NOT reversible. Every diagnostic (severity
// + message + file + line + col) and the driver summary are preserved.

import type { Compressor } from "../types.ts";

// Diagnostic header: `file.swift:LINE:COL: error:/warning:/note:/remark: msg`.
// Path may contain `/`, `.`, `-`, `_`. Covers `.swift` source files. Keep.
// Also matches `<Unknown>:0:` / `<unknown>:0:` aggregate-failure markers.
const DIAG_HEADER_RE =
  /^(<unknown>|<Unknown>|[\w./-]+\.swift):\d+:\d+:\s+(error|warning|note|remark|editor placeholder):/;

// Source-snippet line: the raw source line, indented under the header. swiftc
// prints the source line with NO leading line-number prefix (unlike gcc's
// `N | source`). It is any non-empty line that isn't a caret. We detect it
// contextually (inside a diag block, before the caret). Keep.
// (No standalone regex — handled via inDiag state.)

// Caret underline: `  ^~~~` / `  ^       ~~~~~~~` — carets and tildes pointing
// at the column, optionally with leading spaces. Keep.
const UNDERLINE_RE = /^\s*[\^~]/;

// Trailing driver summary: `error: fatalError`, `error: build had 1 command
// failure`, `error: link command failed`. These are NOT file:line:col
// diagnostics — they're the build driver's final verdict. Keep.
const DRIVER_ERROR_RE = /^error:\s+.+/;

// Version banner: `Swift version 5.10.1`, `swift-driver version: 1.90 ...`,
// `Apple Swift version 5.10`, `swift-frontend version ...`. Drop.
const VERSION_RE =
  /^(Swift|swift-driver|swift-frontend|Apple Swift)\s+version\b/;

// Progress chatter: `Compiling ...`, `Linking ...`, `Building ...`,
// `Generating ...`, `Copying ...`, `Running ...`. Drop.
const PROGRESS_RE =
  /^(Compiling|Linking|Building|Generating|Copying|Running|Emitting|Wrote)\s+/;

// Toolchain-discovery noise: `Finding ...`, `Found ...`, `Considering ...`,
// `Module ... compiled`, `Clang ...`, `note: ...` (driver-level). Drop.
const TOOLCHAIN_RE =
  /^(Finding|Found|Considering|Module|Clang|note:|warning: cannot)\b/;

export const swiftcCompressor: Compressor = {
  name: "swiftc",
  category: "compiler",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `swiftc main.swift`, `swiftc -emit-executable main.swift`,
    // `swift build`, `swift build --configuration release`.
    // EXCLUDE `swift --version` / `swiftc --version` (version info, not a
    // compile), `swift package ...` (package management, not compilation —
    // though `swift build` IS compilation), `swift run` (runs after building,
    // different output shape), `swift test` (test runner).
    if (/^swift(c)?\s+--version/.test(cmd)) return false;
    if (/^swift(c)?\s+-version\b/.test(cmd)) return false;
    if (/^swift\s+package\b/.test(cmd)) return false;
    if (/^swift\s+run\b/.test(cmd)) return false;
    if (/^swift\s+test\b/.test(cmd)) return false;
    // `swift build` (Swift Package Manager build) and bare `swiftc`.
    if (/^swift\s+build\b/.test(cmd)) return true;
    return /^swiftc(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inDiag — inside a diagnostic block (after a header). We keep
    // source lines and underlines while inside a block. A blank line or a
    // non-matching line ends the block.
    let inDiag = false;
    // Track the last diagnostic header for adjacent-dedup.
    let lastHeader = "";

    for (const line of lines) {
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Progress chatter — drop.
      if (PROGRESS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Toolchain-discovery noise — drop.
      if (TOOLCHAIN_RE.test(line)) {
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
      // Inside a diagnostic block.
      if (inDiag) {
        // Blank line ends the block.
        if (line.trim() === "") {
          inDiag = false;
          continue;
        }
        // Caret underline — keep.
        if (UNDERLINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Source line — keep (any non-blank, non-caret line inside a block is
        // the source snippet; swiftc prints it without a line-number prefix).
        kept.push(line);
        continue;
      }
      // Trailing driver summary (`error: fatalError` etc.) — keep.
      if (DRIVER_ERROR_RE.test(line)) {
        kept.push(line);
        continue;
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
