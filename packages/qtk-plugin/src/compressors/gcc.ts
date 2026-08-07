// `gcc` / `clang` / `g++` / `clang++` compressor.
//
// NOTE: this compressor targets DIRECT C/C++ compiler invocation, NOT `make`
// (make is already covered by the `make` compressor, which strips the `cc -c`
// command echoes and keeps the same diagnostic shape). This handles a bare
// `gcc main.c` / `clang++ -c src.cpp` whose output is the raw compiler stream.
//
// gcc/clang diagnostics look like:
//
//   main.c:5:7: warning: unused variable 'count' [-Wunused-variable]
//       5 |   int count = 0;
//         |       ^~~~~
//   main.c:12:10: error: use of undeclared identifier 'missing_var'
//      12 |   return missing_var;
//         |          ^
//   main.c:15:3: error: conflicting types for 'process'
//      15 |   process(value);
//         |   ^
//   main.c:3:6: note: previous declaration is here
//       3 | void process(double x);
//         |      ^~~~~~~~~~~~~~~~~~
//   2 warnings and 3 errors generated.
//
// Linker errors (ld, invoked by the compiler driver) look like:
//
//   /usr/bin/ld: main.o: in function `main':
//   main.c:(.text+0x3a): undefined reference to `compute'
//   /usr/bin/ld: cannot find -lcustomlib: No such file or directory
//   collect2: error: ld returned 1 exit status
//
// The signal lives in:
//   - The `file.c:LINE:COL: error:/warning:/note: msg` diagnostic headers (the
//     severity + message + location are all actionable).
//   - The source-snippet lines (`  N | source`) and the caret underline
//     (`  | ^~~`) — they pin the exact column.
//   - The `N warnings/errors generated.` summary (clang) / nothing-equivalent
//     for gcc (gcc just exits non-zero).
//   - Linker errors: `undefined reference to`, `cannot find -l`, `ld returned
//     1 exit status`, `collect2: error:`.
//
// The bulk that CAN be compressed:
//   - The version banner (`clang version 18.1.8`, `gcc (GCC) 14.2.1 ...`).
//   - The `Target:` / `Thread model:` / `InstalledDir:` config lines.
//   - The `Found candidate GCC installation:` / `Selected GCC installation:`
//     / `Candidate multilib:` / `Selected multilib:` toolchain-discovery lines.
//   - The compiler invocation echo (the giant `"/usr/bin/clang-18" -cc1 ...`
//     line — clang prints its full argv when it crashes or with `-v`).
//   - The linker invocation echo (the giant `"/usr/bin/ld" ...` line).
//
// Strategy: keep diagnostic headers, source snippets, underlines, the
// `N warnings/errors generated.` summary, and linker errors; drop version
// banners, toolchain-discovery noise, and the compiler/linker invocation
// echoes. This mirrors the rustc compressor (compiler diagnostics with span
// locators + source context). Adjacent identical diagnostics are deduplicated.
//
// This compressor is LOSSY: it drops version banners, toolchain-discovery
// lines, and the compiler/linker invocation echoes. It is NOT reversible.
// Every diagnostic (severity + message + file + line + col) and the summary
// are preserved.

import type { Compressor } from "../types.ts";

// Diagnostic header: `file.c:LINE:COL: error:/warning:/note: msg`.
// Path may contain `:`, so we anchor on the `:NUM:NUM: severity:` suffix.
// Covers C/C++/header/objective-C extensions. Keep.
const DIAG_HEADER_RE = /^[\w./-]+\.(c|cc|cpp|cxx|C|c\+\+|h|hh|hpp|hxx|m|mm|s|S):\d+:\d+:\s+(error|warning|note|fatal error):/;

// Source-snippet line: `   N | source` (clang) or `   N |source` variants.
// The leading number is the source line. Keep.
const SOURCE_LINE_RE = /^\s*\d+\s+\|/;

// Caret underline: `     |   ^~~~~ msg`. Keep.
const UNDERLINE_RE = /^\s*\|\s*[\^~]/;

// Standalone border pipe: `     |` (decorative separator clang prints between
// the snippet and the underline). Drop.
const BORDER_PIPE_RE = /^\s*\|\s*$/;

// Summary: `N warnings and M errors generated.` (clang). Keep.
const SUMMARY_RE = /^\d+\s+(warnings?|errors?)\s+(and\s+\d+\s+(warnings?|errors?)\s+)?generated\./;

// Linker error lines. Keep.
// `/usr/bin/ld: ...` — any ld diagnostic line.
const LD_RE = /^.*\bld\b.*:/;
// `undefined reference to `symbol`` — the most common linker error.
const UNDEFINED_REF_RE = /undefined reference to/;
// `cannot find -lNAME` — missing library.
const CANNOT_FIND_RE = /cannot find -l/;
// `collect2: error: ld returned 1 exit status` — gcc's linker-failure wrapper.
const COLLECT2_RE = /^collect2:\s+error:/;

// Version banner: `clang version 18.1.8` / `gcc (GCC) 14.2.1 ...`. Drop.
const VERSION_RE = /^(clang|gcc|g\+\+|clang\+\+|Apple clang|cc)\s+(version\s+)?\d/;

// Toolchain-discovery noise. Drop.
const TOOLCHAIN_RE = /^(Target:|Thread model:|InstalledDir:|Found candidate|Selected (GCC|multilib)|Candidate multilib):/;

// Compiler/linker invocation echo: a line starting with a quoted path then
// flags (clang/gcc print this with `-v` or on crash). Drop.
// e.g. ` "/usr/bin/clang-18" -cc1 ...` or ` "/usr/bin/ld" -pie ...`.
const INVOCATION_RE = /^\s*"[^"]+"\s+-/;

export const gccCompressor: Compressor = {
  name: "gcc",
  category: "compiler",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `gcc main.c`, `clang -c src.c`, `g++ -o app app.cpp`, `clang++ src.mm`.
    // EXCLUDE `gcc --version` / `gcc -v` (version/sysroot info, not a compile),
    // `gcc -dumpversion`, `gcc -print-*` (sysroot/config queries).
    if (/^(gcc|g\+\+|clang|clang\+\+|cc)\s+--?v/.test(cmd)) return false;
    if (/^(gcc|g\+\+|clang|clang\+\+|cc)\s+-dump/.test(cmd)) return false;
    if (/^(gcc|g\+\+|clang|clang\+\+|cc)\s+-print/.test(cmd)) return false;
    return /^(gcc|g\+\+|clang|clang\+\+|cc)(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inDiag — inside a diagnostic block (after a header). We keep
    // source lines, underlines while inside a block. A blank line or a
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
      // Toolchain-discovery noise — drop.
      if (TOOLCHAIN_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Compiler/linker invocation echo — drop.
      if (INVOCATION_RE.test(line)) {
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
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        inDiag = false;
        continue;
      }
      // Linker errors — keep.
      if (LD_RE.test(line) || UNDEFINED_REF_RE.test(line) ||
          CANNOT_FIND_RE.test(line) || COLLECT2_RE.test(line)) {
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
        // Source line — keep.
        if (SOURCE_LINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Underline — keep.
        if (UNDERLINE_RE.test(line)) {
          kept.push(line);
          continue;
        }
        // Standalone border pipe — drop (decorative).
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
