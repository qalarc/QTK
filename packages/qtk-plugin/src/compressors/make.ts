// `make` / `make build` / `make install` compressor.
//
// Make output is verbose in a predictable way:
//   - Each rule echoes the command it runs (`cc -c -O2 ...`, `ar rcs ...`,
//     `tsc --outDir ...`). For a build with dozens of source files this is
//     a wall of command echoes that the model rarely needs.
//   - On success, make prints nothing (or a final link line). The exit
//     code carries the signal, but the model sees stdout/stderr, so the
//     absence of errors IS the success indicator.
//   - On failure, the signal is in compiler/linker diagnostics
//     (`file.c:LINE:COL: error: ...`) and the make-level error
//     (`make: *** [Makefile:LINE: target] Error N`).
//
// For the model:
//   - On success: a compact "N commands ran, no errors" summary (or just
//     the final link/binary line if present).
//   - On failure: the compiler/linker errors + the `make: ***` line.
//   - The command echoes (`cc -c ...`) are noise.
//   - Actionable warnings (the kind that precede errors) are kept; pure
//     `-Wunused` chatter on a clean build is dropped.
//
// Strategy: keep diagnostics (errors + warnings) + make errors + final
// success markers, drop command echoes + progress noise.
//
// This compressor is LOSSY: it drops the command echoes. It is NOT
// reversible. The dropped lines are gone.

import type { Compressor } from "../types.ts";

// Command-echo lines. Make prints the recipe verbatim before running it.
// Common shapes:
//   `cc -c -O2 ...` / `gcc ...` / `g++ ...` / `clang ...` / `ar rcs ...`
//   `tsc --outDir ...` / `cargo build ...` / `rustc ...`
//   `mkdir -p ...` / `cp ...` / `rm -f ...` / `install -c ...`
//   `ld ...` / `ranlib ...`
const CMD_ECHO_RE =
  /^\s*(cc|gcc|g\+\+|clang|clang\+\+|rustc|cargo|tsc|tsc\.js|node|ar|ld|ranlib|mkdir|cp|mv|rm|install|ln|strip|objcopy|objdump)\s+/;

// Compiler/linker diagnostic: `file.c:LINE:COL: severity: msg` or
// `file.c:LINE: severity: msg` (gcc/clang style). Also handles absolute
// paths and paths with subdirs. Extensions: .c .cc .cpp .cxx .h .hpp .rs .ts .tsx .js .go .m .mm
const DIAG_RE =
  /^(?:\.\.?\/)?(?:[\w./-]+)\.(?:c|cc|cpp|cxx|h|hpp|hh|rs|ts|tsx|js|jsx|go|m|mm|s|S|f|f90):\d+(?::\d+)?:\s/;

// Makefile error: `make: *** [Makefile:24: target] Error N`
// Also: `make[N]: *** [...] Error N` for sub-makes, and
// `make: *** No rule to make target 'foo'.  Stop.`
const MAKE_ERROR_RE = /^make(?:\[\d+\])?:\s+\*\*\*/;
// `make: *** [target] Error N` — the summary we always keep.

// Generic error/warning keywords that aren't on a `file:line:` prefix.
// e.g. `undefined reference to 'foo'` (linker), `collect2: error: ld returned 1`
const ERROR_KW_RE = /\b(error|undefined reference|collect2:|ld returned|cannot find|fatal error)\b/i;
const WARN_KW_RE = /\b(warning|warn)\b/i;

// A "note" continuation line from gcc/clang:
//   `note: previous declaration is here` / `note: ...`
// These follow a diagnostic and add context — keep them.
const NOTE_RE = /^\s*(?:\.\.?\/)?(?:[\w./-]+):\d+(?::\d+)?:\s*note:/i;

// Success markers we keep:
//   - `Build complete` / `build complete`
//   - a final binary link line is a command echo (dropped), but if make
//     prints a summary like `Created binary foo` we keep it.
const SUCCESS_RE = /\b(build complete|build succeeded|created binary|linking succeeded|done\.)\b/i;

// The indented source-snippet lines gcc prints under a diagnostic:
//   `   42 |       emit_label(ctx, "L_if_end");`
//   `      |       ^~~~~~~~~~`
// These are continuation context for the preceding diagnostic — keep them
// only if the preceding kept line was a diagnostic. We handle this with a
// one-line lookback.
const SNIPPET_RE = /^\s+\d+\s*\|/;
const SNIPPET_CARET_RE = /^\s*\|/;

export const makeCompressor: Compressor = {
  name: "make",
  category: "build-tool",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // Bare `make` or `make <target>` (build, all, install, clean, test, etc.)
    // Exclude `make` with shell-redirection or compound already excluded above.
    return /^make(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const diagnostics: string[] = [];
    const makeErrors: string[] = [];
    const successes: string[] = [];
    let commandsDropped = 0;
    let lastKeptWasDiag = false;

    for (const line of lines) {
      // Make errors — always keep.
      if (MAKE_ERROR_RE.test(line)) {
        makeErrors.push(line.trim());
        lastKeptWasDiag = false;
        continue;
      }
      // Compiler/linker diagnostics — keep.
      if (DIAG_RE.test(line) || NOTE_RE.test(line)) {
        diagnostics.push(line.trim());
        lastKeptWasDiag = true;
        continue;
      }
      // Source-snippet continuation lines — keep only if they follow a diag.
      if (
        (SNIPPET_RE.test(line) || SNIPPET_CARET_RE.test(line)) &&
        lastKeptWasDiag
      ) {
        diagnostics.push(line);
        continue;
      }
      // Success markers — keep.
      if (SUCCESS_RE.test(line)) {
        successes.push(line.trim());
        lastKeptWasDiag = false;
        continue;
      }
      // Lines with explicit error/warning keywords (linker errors, etc.).
      if (ERROR_KW_RE.test(line)) {
        diagnostics.push(line.trim());
        lastKeptWasDiag = true;
        continue;
      }
      if (WARN_KW_RE.test(line)) {
        diagnostics.push(line.trim());
        lastKeptWasDiag = true;
        continue;
      }
      // Command echoes — drop.
      if (CMD_ECHO_RE.test(line)) {
        commandsDropped++;
        lastKeptWasDiag = false;
        continue;
      }
      // Blank lines — drop, but reset the snippet-continuation flag.
      if (line.trim() === "") {
        lastKeptWasDiag = false;
        continue;
      }
      // Unknown line — if it follows a diagnostic and is indented, treat
      // it as continuation context (keep). Otherwise drop as noise.
      if (lastKeptWasDiag && /^\s+/.test(line)) {
        diagnostics.push(line);
        continue;
      }
      commandsDropped++;
      lastKeptWasDiag = false;
    }

    // If we found nothing meaningful, return raw.
    if (
      diagnostics.length === 0 &&
      makeErrors.length === 0 &&
      successes.length === 0
    ) {
      return raw;
    }

    const out: string[] = [];
    if (diagnostics.length > 0) {
      out.push(`${diagnostics.length} diagnostic(s):`);
      out.push(...diagnostics.slice(0, 30));
      if (diagnostics.length > 30) {
        out.push(`... +${diagnostics.length - 30} more`);
      }
    }
    if (makeErrors.length > 0) {
      out.push("");
      out.push(...makeErrors.slice(0, 5));
    }
    if (successes.length > 0) {
      out.push("");
      out.push(...successes.slice(0, 5));
    }
    if (commandsDropped > 0) {
      out.push(`(${commandsDropped} command-echo lines dropped)`);
    }

    const result = out.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
