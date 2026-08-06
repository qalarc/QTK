// `mvn` (Apache Maven) compressor.
//
// Maven reactor builds (`mvn install`, `mvn test`, `mvn clean install`) emit a
// torrent of `[INFO]` lines that are pure progress chatter:
//   - `[INFO] Building <module> <version> [N/M]` — one per module, every build.
//   - `[INFO] --- plugin:version:goal (id) @ module ---` — one per plugin
//     execution per module (resources, compiler, surefire, install...). On a
//     multi-module build this is dozens of lines of structural noise.
//   - `Downloading from central: https://...` / `Downloaded from central: ...`
//     — dependency fetch noise, huge on first build or CI.
//   - `[INFO] Compiling N source files ...`, `[INFO] Copying N resources.`,
//     `[INFO] Using 'UTF-8' encoding ...` — plugin sub-step chatter.
//   - `[INFO] Reactor Build Order:` + the module list — structural, rarely
//     actionable (the Reactor Summary at the end is the useful one).
//
// The signal lives in:
//   - `[ERROR]` lines: compiler errors, test failures, build errors, the
//     `Failed to execute goal ...` summary, and the `[Help 1]` pointer.
//   - Compiler diagnostics: `file.java:[LINE,COL] message` (javac format with
//     brackets) + the `N errors` count.
//   - Test results: `Tests run: X, Failures: Y, Errors: Z, Skipped: W` (both
//     per-class and the aggregate `Results:` block), plus the per-test failure
//     detail lines (`  TestClass.testMethod:LINE expected:<a> but was:<b>`).
//   - `[INFO] BUILD FAILURE` / `[INFO] BUILD SUCCESS` summary.
//   - The `Reactor Summary for ...` block (which modules passed/failed).
//   - `Caused by:` exception chains.
//
// Strategy: keep `[ERROR]` lines, compiler diagnostics, test results + failure
// details, the build summary, the reactor summary block, and `Caused by:`
// chains; drop `[INFO]` chatter, download progress, plugin-execution banners,
// and the reactor build-order list.
//
// This compressor is LOSSY: it drops `[INFO]` progress chatter, download
// progress, plugin-execution banners, and the build-order list. It is NOT
// reversible. Errors, test results, failure details, and the build/reactor
// summaries are preserved.

import type { Compressor } from "../types.ts";

// `[ERROR] ...` — always keep (compiler errors, test failures, build errors).
const ERROR_RE = /^\[ERROR\]\s?(?<msg>.*)$/;

// `[INFO] BUILD FAILURE` / `[INFO] BUILD SUCCESS` — keep the verdict.
const BUILD_VERDICT_RE = /^\[INFO\]\s+BUILD\s+(FAILURE|SUCCESS)\b/;

// `[INFO] Total time:  03.421 s` — keep (part of the summary block).
const TOTAL_TIME_RE = /^\[INFO\]\s+Total time:/;

// `[INFO] Reactor Summary for <artifact>:` — start of the reactor summary
// block we keep (it shows which modules passed/failed with timings).
const REACTOR_SUMMARY_RE = /^\[INFO\]\s+Reactor Summary\b/;

// `[INFO] ----------------< com.example:parent >----------------` — the
// artifact separator banner. Drop (structural noise).
const ARTIFACT_BANNER_RE = /^\[INFO\]\s+-{4,}\s*<.*>\s*-{4,}/;

// `[INFO] Building <module> <version> [N/M]` — per-module build banner. Drop.
const BUILDING_RE = /^\[INFO\]\s+Building\s+\S+/;

// `[INFO] --- plugin:version:goal (id) @ module ---` — plugin execution. Drop.
const PLUGIN_EXEC_RE = /^\[INFO\]\s+---\s+[\w.-]+:[\w.-]+:[\w.-]+/;

// `[INFO] Reactor Build Order:` — the build-order list. Drop (the Summary at
// the end is the useful one).
const BUILD_ORDER_RE = /^\[INFO\]\s+Reactor Build Order:/;

// `Downloading from ...` / `Downloaded from ...` — dependency fetch noise.
const DOWNLOAD_RE = /^(Downloading|Downloaded)\s+from\s+/;

// javac diagnostic (Maven format): `file.java:[LINE,COL] message` or
// `file.java:[LINE] message`. The `[ERROR]` prefix is stripped before this
// check, so we match the bare diagnostic.
const JAVAC_DIAG_RE =
  /^(?<file>[\w./-]+\.java):\[(?<loc>\d+(?:,\d+)?)\]\s+(?<msg>.*)$/;

// `N errors` / `N error` — javac error count summary.
const JAVAC_COUNT_RE = /^\d+\s+errors?$/;

// `[INFO] Tests run: X, Failures: Y, Errors: Z, Skipped: W` — keep (per-class
// and aggregate). Maven prints these with the `[INFO] ` prefix.
const TESTS_RUN_RE = /^\[INFO\]\s+Tests run:\s+\d+/i;

// `[INFO] Results:` — start of the aggregate test results block. Keep marker.
const RESULTS_RE = /^\[INFO\]\s+Results:/;

// Per-test failure detail. Maven prints these as:
//   `[INFO]   TestClass.testMethod:LINE message`
// (note the `[INFO]` prefix + extra indent). Keep only the payload.
const TEST_DETAIL_RE =
  /^\[INFO\]\s+(?<detail>[\w.$]+\.test\w*:\d+\s+.*)$/;

// `Caused by: ...` — exception chain continuation. Keep.
const CAUSED_BY_RE = /^\s*Caused by:\s+/;

// Stack-trace lines (indented `at ...`) — drop unless following a Caused by.
const STACK_TRACE_RE = /^\s+at\s+/;

// `[INFO] --------` separator lines (the dashed dividers). Drop.
const SEPARATOR_RE = /^\[INFO\]\s+-{20,}/;

// `[INFO]` generic chatter — the catch-all drop.
const INFO_RE = /^\[INFO\]/;

export const mvnCompressor: Compressor = {
  name: "mvn",
  category: "build-tool",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `mvn`, `mvn install`, `mvn clean install`, `mvn test`, `mvn package`.
    // Exclude `mvnd` (Maven daemon) and `mvnvm` — different tools.
    return /^mvn(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State flags for context-sensitive keeping:
    //   - inReactorSummary: inside the `Reactor Summary` block (keep module
    //     result lines + the trailing separator/verdict).
    //   - inResults: inside the `[INFO] Results:` block (keep the aggregate
    //     Tests run line; the per-class line is kept unconditionally).
    //   - keepStack: just saw a `Caused by:` — keep the immediate stack frame.
    let inReactorSummary = false;
    let inResults = false;
    let keepStack = false;

    for (const line of lines) {
      // Build verdict — always keep, ends reactor summary.
      if (BUILD_VERDICT_RE.test(line)) {
        kept.push(line.trim());
        inReactorSummary = false;
        inResults = false;
        keepStack = false;
        continue;
      }
      // Total time — keep (part of summary).
      if (TOTAL_TIME_RE.test(line)) {
        kept.push(line.trim());
        inReactorSummary = false;
        inResults = false;
        keepStack = false;
        continue;
      }
      // Reactor Summary header — keep, enter block.
      if (REACTOR_SUMMARY_RE.test(line)) {
        kept.push(line.trim());
        inReactorSummary = true;
        inResults = false;
        keepStack = false;
        continue;
      }
      // Inside reactor summary: keep module result lines (they look like
      // `[INFO] module .... SUCCESS [ 1.234 s]` or FAILURE).
      if (inReactorSummary) {
        if (INFO_RE.test(line) && /\b(SUCCESS|FAILURE|SKIPPED)\b/.test(line)) {
          kept.push(line.trim());
          continue;
        }
        if (SEPARATOR_RE.test(line)) {
          // End of reactor summary block — drop the separator, exit block.
          inReactorSummary = false;
          continue;
        }
        // Blank or other lines inside the block — skip quietly.
        if (line.trim() === "") continue;
        noiseDropped++;
        continue;
      }
      // `[ERROR]` lines — always keep. Strip the prefix for scannability but
      // preserve the content. Also check if the payload is a javac diagnostic.
      const errMatch = line.match(ERROR_RE);
      if (errMatch && errMatch.groups) {
        const msg = errMatch.groups.msg!;
        kept.push(`[ERROR] ${msg}`);
        inResults = false;
        keepStack = false;
        continue;
      }
      // `[INFO] Results:` — keep marker, enter block.
      if (RESULTS_RE.test(line)) {
        kept.push(line.trim());
        inResults = true;
        keepStack = false;
        continue;
      }
      // `Tests run: ...` — keep (per-class or aggregate).
      if (TESTS_RUN_RE.test(line)) {
        kept.push(line.trim());
        keepStack = false;
        continue;
      }
      // Per-test failure detail (`[INFO]   TestClass.testMethod:LINE ...`) —
      // keep the payload (strip the `[INFO]` prefix).
      const detailMatch = line.match(TEST_DETAIL_RE);
      if (detailMatch && detailMatch.groups) {
        kept.push(detailMatch.groups.detail!.trim());
        keepStack = false;
        continue;
      }
      // `Caused by:` — keep, set flag to keep the immediate stack frame.
      if (CAUSED_BY_RE.test(line)) {
        kept.push(line.trim());
        keepStack = true;
        continue;
      }
      // Stack-trace `at ...` lines — keep only the first after Caused by.
      if (STACK_TRACE_RE.test(line)) {
        if (keepStack) {
          kept.push(line);
          keepStack = false;
        } else {
          noiseDropped++;
        }
        continue;
      }
      // Bare javac diagnostic (no [ERROR] prefix, e.g. in compiler output) — keep.
      if (JAVAC_DIAG_RE.test(line)) {
        kept.push(line.trim());
        keepStack = false;
        continue;
      }
      // javac `N errors` count — keep.
      if (JAVAC_COUNT_RE.test(line.trim())) {
        kept.push(line.trim());
        keepStack = false;
        continue;
      }
      // Download noise — drop.
      if (DOWNLOAD_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Plugin execution banners — drop.
      if (PLUGIN_EXEC_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Building <module> banners — drop.
      if (BUILDING_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Reactor Build Order — drop.
      if (BUILD_ORDER_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Artifact separator banners — drop.
      if (ARTIFACT_BANNER_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Separator lines — drop.
      if (SEPARATOR_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Blank lines — drop, reset flags.
      if (line.trim() === "") {
        inResults = false;
        keepStack = false;
        continue;
      }
      // Generic `[INFO]` chatter — drop.
      if (INFO_RE.test(line)) {
        noiseDropped++;
        keepStack = false;
        continue;
      }
      // Unknown non-INFO line — keep defensively if it looks like an error.
      if (/\b(error|failed|failure|cannot find|exception)\b/i.test(line)) {
        kept.push(line.trim());
        keepStack = false;
        continue;
      }
      noiseDropped++;
      keepStack = false;
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
