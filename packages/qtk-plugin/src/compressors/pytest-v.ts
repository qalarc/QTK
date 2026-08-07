// `pytest-v` compressor (verbose mode).
//
// pytest with `-v` / `--verbose` emits one line PER TEST:
//
//   tests/test_foo.py::test_add PASSED [ 12%]
//   tests/test_foo.py::test_sub PASSED [ 25%]
//   tests/test_bar.py::test_fail FAILED [ 37%]
//
// followed by failure detail blocks (same `____ test_name ____` headers +
// tracebacks as default mode) and a final summary:
//
//   ========================= 1 failed, 2 passed in 0.83s =========================
//
// On a green run, verbose output is ~95% PASSED lines — pure noise. The summary
// count (`N passed in Xs`) already tells the model the result. On a red run, the
// FAILED lines + their tracebacks are the signal.
//
// Strategy:
//   - KEEP: `FAILED` lines, `ERROR` lines, collection errors, the failure detail
//     blocks (tracebacks), and the final `=== N failed, M passed in Xs ===`
//     summary.
//   - DROP: `PASSED` lines (the bulk of a green run — the summary count is
//     enough), `SKIPPED` lines (count is in the summary), the `[ NN%]` progress
//     markers, the session header, `collected N items`, progress dots/bars.
//
// DISTINCTION FROM THE GENERIC `pytest` COMPRESSOR:
//   - The generic `pytest` compressor handles DEFAULT (non-verbose) output,
//     where progress is shown as dots/`F`/`E` characters on a line like
//     `tests/test_foo.py .F.F.`. It keys off the `=== N passed/failed ===`
//     summary and the `FAILED tests/...::... - msg` short-summary lines.
//   - This `pytest-v` compressor handles VERBOSE output, where each test gets
//     its own `::test_name PASSED|FAILED` line. It is registered BEFORE the
//     generic pytest compressor and matches ONLY when `-v` / `--verbose` is
//     present in the command, so the two never overlap. If `-v` is absent, the
//     generic pytest compressor handles it.
//
// This compressor is LOSSY: it drops all PASSED lines (and SKIPPED lines). It
// is NOT reversible. Every failure (test name + traceback) and the final
// summary are preserved. On a fully-passing run, only the summary survives.

import type { Compressor } from "../types.ts";

// Verbose per-test line: `tests/test_foo.py::test_name PASSED   [ 12%]`
// or `tests/test_foo.py::test_name::param[1] FAILED    [ 37%]`.
// The node id is `file::test` (possibly `::param`), then a status word, then an
// optional `[ NN%]` progress bracket. We match on the trailing status.
const PASSED_RE = /\bPASSED\s*(\[[\s\d]+%\])?$/;
const FAILED_LINE_RE = /\bFAILED\s*(\[[\s\d]+%\])?$/;
const ERROR_LINE_RE = /\bERROR\s*(\[[\s\d]+%\])?$/;
const SKIPPED_RE = /\bSKIPPED\b/;

// Final summary: `=== N failed, M passed in Xs ===` / `=== N passed in Xs ===`.
// Also matches `=== N passed, M skipped ===` and error-only summaries.
const SUMMARY_RE = /^=+\s+\d+\s+(passed|failed|error|skipped)/;

// Short-test-summary block (pytest prints this before the final line on
// failures): `FAILED tests/...::test_name - assert ...`. Keep.
const SHORT_FAILED_RE = /^FAILED\s+\S+\s+-\s+/;
const SHORT_ERROR_RE = /^ERROR\s+\S+\s+-\s+/;

// Failure section header: `____ test_name ____`. Keep (starts a traceback block).
const SECTION_RE = /^_{3,}\s+.+\s+_{3,}$/;

// Collection error header: `ERROR collecting ...`. Keep.
const COLLECT_ERROR_RE = /^ERROR collecting/;

// Session header / banner lines. Drop.
const SESSION_HEADER_RE = /^=+\s*test session starts\s*=+/;
const PLATFORM_RE = /^platform\s+/;
const ROOTDIR_RE = /^rootdir:/;
const COLLECTED_RE = /^collected\s+\d+\s+items?$/;

// `=== short test summary info ===` divider. Drop (we keep the FAILED lines
// that follow it individually).
const SHORT_SUMMARY_DIV_RE = /^=+\s*short test summary info\s*=+/;

// `=== no tests ran ===` edge case. Keep (it's a summary).
const NO_TESTS_RE = /^=+\s*no tests ran/;

export const pytestVCompressor: Compressor = {
  name: "pytest-v",
  category: "test-runner",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // Must be a pytest invocation WITH -v / --verbose.
    const isPytest = /^(python\s+-m\s+pytest|pytest)\b/.test(cmd);
    if (!isPytest) return false;
    // `-v` as its own token, or `--verbose`. Avoid matching `-vv` only (that's
    // a different verbosity level but still verbose, so allow it). Match `-v`
    // as a standalone flag token (preceded by space or start, followed by space
    // or end). Also catch `-vs` / `-vx` combined short flags.
    if (/(^|\s)--verbose(\s|$)/.test(cmd)) return true;
    if (/(^|\s)-v[vxs]*(\s|$)/.test(cmd)) return true;
    return false;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    // Find the final summary line first — it's the anchor that tells us this is
    // real pytest-v output.
    let summary: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (SUMMARY_RE.test(line) || NO_TESTS_RE.test(line)) {
        summary = line.replace(/=+/g, "").trim();
        break;
      }
    }
    // No summary → not recognizable pytest-v output. Return raw.
    if (!summary) return raw;

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inFailureBlock — inside a `____ test_name ____` traceback block.
    // Keep lines until we hit a `===` divider.
    let inFailureBlock = false;

    for (const line of lines) {
      // Inside a failure traceback block — keep everything until a divider.
      if (inFailureBlock) {
        if (/^=+/.test(line)) {
          inFailureBlock = false;
          // Don't keep the divider line itself (could be the short-summary or
          // the final summary — both are handled separately).
          continue;
        }
        kept.push(line);
        continue;
      }

      // Final summary line — skip here (we prepend the cleaned summary at the
      // end). Avoid double-counting.
      if (SUMMARY_RE.test(line) || NO_TESTS_RE.test(line)) {
        continue;
      }

      // Session header / banner / config noise — drop.
      if (
        SESSION_HEADER_RE.test(line) ||
        PLATFORM_RE.test(line) ||
        ROOTDIR_RE.test(line) ||
        COLLECTED_RE.test(line) ||
        SHORT_SUMMARY_DIV_RE.test(line)
      ) {
        noiseDropped++;
        continue;
      }

      // PASSED line — the bulk of a green run. Drop.
      if (PASSED_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // SKIPPED line — count is in the summary. Drop.
      if (SKIPPED_RE.test(line)) {
        noiseDropped++;
        continue;
      }

      // FAILED verbose line (`::test FAILED [ NN%]`) — keep.
      if (FAILED_LINE_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // ERROR verbose line — keep.
      if (ERROR_LINE_RE.test(line)) {
        kept.push(line);
        continue;
      }

      // Short-summary FAILED/ERROR lines (`FAILED tests/...::x - msg`) — keep.
      if (SHORT_FAILED_RE.test(line) || SHORT_ERROR_RE.test(line)) {
        kept.push(line);
        continue;
      }

      // Collection error — keep.
      if (COLLECT_ERROR_RE.test(line)) {
        kept.push(line);
        continue;
      }

      // Failure section header (`____ test_name ____`) — keep + enter block.
      if (SECTION_RE.test(line)) {
        kept.push(line);
        inFailureBlock = true;
        continue;
      }

      // Blank lines — drop (collapse separators).
      if (line.trim() === "") {
        continue;
      }

      // Unknown non-blank line. If it looks like a traceback / error detail
      // (common inside failure blocks we already handle, but also for lines
      // like `E   assert 2 == 3` that may appear outside a recognized section),
      // keep it defensively. Otherwise drop as noise.
      if (/^(E\s|>|tests\/|\S+\.py:\d+:|\s+assert\s|Error|Traceback)/.test(line)) {
        kept.push(line);
        continue;
      }
      noiseDropped++;
    }

    // Build output: summary first, then kept failure detail.
    const out: string[] = [`pytest: ${summary}`];
    if (kept.length > 0) {
      out.push("");
      out.push(...kept);
    }
    if (noiseDropped > 0) {
      out.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = out.join("\n").trimEnd();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
