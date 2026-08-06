// `gradle` / `./gradlew` compressor.
//
// Gradle multi-module builds (`gradle build`, `gradle test`, `gradle assemble`,
// `./gradlew ...`) produce a wall of per-task lines:
//   - `> Task :module:compileJava` — one per task per module. On a clean build
//     these are pure progress noise (the model cares about failures, not the
//     200 successful compiles).
//   - `Downloading https://...` / `Downloaded https://...` — dependency fetch
//     noise, huge on first build or CI.
//   - `> Configure project :module` + `Resolve dependencies of ...` — config
//     phase chatter.
//   - `Deprecated features` / `Using Gradle X.Y` — version banners.
//
// The signal lives in:
//   - Task FAILURE lines: `> Task :module:compileJava FAILED`
//   - javac diagnostics: `file.java:LINE: error: ...` + the `N errors` count
//   - Test failures: `<TestClass > <testMethod() FAILED` + the stack, and the
//     `N tests completed, M failed` summary
//   - The `* What went wrong:` explanation block
//   - The final `BUILD SUCCESSFUL in Ns` / `BUILD FAILED in Ns` summary
//
// Strategy: keep failures + diagnostics + the "What went wrong" block + the
// final summary; drop successful task lines, download noise, config chatter,
// and deprecation banners.
//
// This compressor is LOSSY: it drops successful `> Task :...` lines, download
// progress, and config/deprecation noise. It is NOT reversible. Failures,
// diagnostics, test-failure details, and the build summary are preserved.

import type { Compressor } from "../types.ts";

// `> Task :module:compileJava` — a task line. We keep it only if it ends with
// ` FAILED` (or ` UP-TO-DATE` is dropped as noise). The bare task line itself
// is the progress unit; the FAILED marker is the signal.
const TASK_RE = /^>\s+Task\s+(:[\w:-]+)/;

// `> Task :module:compileJava FAILED` — a failed task. Always keep.
const TASK_FAILED_RE = /^>\s+Task\s+:[\w:-]+\s+FAILED\b/;

// javac diagnostic: `path/File.java:LINE: error: msg` (also `: warning:`).
// Handles absolute/relative paths and `.java` extension.
const JAVAC_DIAG_RE =
  /^(?<file>[\w./-]+\.java):(?<line>\d+):\s+(?<severity>error|warning):\s+(?<msg>.*)$/;

// The `N errors` / `N warning(s)` summary javac prints after a compile.
const JAVAC_COUNT_RE = /^\d+\s+(error|warning)/;

// javac `Note:` continuation lines (deprecated/unchecked API notices).
const JAVAC_NOTE_RE = /^Note:/;

// Test failure line: `com.example.FooTest > testBar() FAILED`
const TEST_FAILED_RE =
  /^(?<class>[\w.]+)\s+>\s+(?<method>\w+)\(\)\s+FAILED\b/;

// Test pass line: `com.example.FooTest > testBar() PASSED` — noise, drop.
const TEST_PASSED_RE = /^[\w.]+\s+>\s+\w+\(\)\s+PASSED\b/;

// Test summary: `4 tests completed, 2 failed`
const TEST_SUMMARY_RE = /^\d+\s+tests?\s+completed/;

// Stack-trace lines (indented `at ...`) — keep only under a FAILED test.
const STACK_TRACE_RE = /^\s+at\s+/;

// Download noise: `Downloading https://...` / `Downloaded https://...`
const DOWNLOAD_RE = /^(Downloading|Downloaded)\s+https?:\/\//;

// Config-phase chatter: `> Configure project :...`, `Resolve dependencies ...`
const CONFIG_RE = /^(>\s+Configure project|Resolving dependencies)/;

// Version / deprecation banners.
const BANNER_RE =
  /^(Using Gradle|The automatic loading|Deprecated features|This is scheduled to be removed)/;

// `> Task :module:processResources NO-SOURCE` and similar — noise.
const TASK_NOSOURCE_RE = /^>\s+Task\s+:[\w:-]+\s+NO-SOURCE\b/;

// The "What went wrong" block marker — start of the explanation we keep.
const WHAT_WENT_WRONG_RE = /^\*\s+What went wrong:/;

// The `* Try:` / `* Get more help` blocks — drop (not actionable for the model).
const TRY_BLOCK_RE = /^\*\s+(Try|Get more help)/;

// Final build summary: `BUILD SUCCESSFUL in 5s` / `BUILD FAILED in 12s`
const BUILD_SUMMARY_RE = /^BUILD\s+(SUCCESSFUL|FAILED)\b/i;

// `FAILURE: Build failed with an exception.` — keep (signals failure).
const FAILURE_BANNER_RE = /^FAILURE:/;

export const gradleCompressor: Compressor = {
  name: "gradle",
  category: "build-tool",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `gradle`, `gradle build`, `gradle test`, `./gradlew`, `./gradlew assemble`
    // but NOT `gradle-wrapper` or paths containing gradle as a substring.
    return /^(?:\.\/)?gradle(?:w)?(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State machine for context-sensitive keeping:
    //   - inWhatWentWrong: inside the `* What went wrong:` block (keep until
    //     the next `* ` block or BUILD summary).
    //   - inFailedTest: just saw a `<class> > <method>() FAILED` line, so the
    //     following indented stack-trace lines are kept.
    let inWhatWentWrong = false;
    let inFailedTest = false;

    for (const line of lines) {
      // Final build summary — always keep, ends any block.
      if (BUILD_SUMMARY_RE.test(line)) {
        kept.push(line.trim());
        inWhatWentWrong = false;
        inFailedTest = false;
        continue;
      }
      // `FAILURE: Build failed with an exception.` — keep.
      if (FAILURE_BANNER_RE.test(line)) {
        kept.push(line.trim());
        inWhatWentWrong = false;
        inFailedTest = false;
        continue;
      }
      // `* What went wrong:` block start — keep, enter block.
      if (WHAT_WENT_WRONG_RE.test(line)) {
        kept.push(line.trim());
        inWhatWentWrong = true;
        inFailedTest = false;
        continue;
      }
      // `* Try:` / `* Get more help` blocks — drop, exit what-went-wrong.
      if (TRY_BLOCK_RE.test(line)) {
        inWhatWentWrong = false;
        inFailedTest = false;
        noiseDropped++;
        continue;
      }
      // Inside the what-went-wrong block: keep non-blank lines (the
      // explanation + `> Cause:` chains) until we hit a `* ` block or summary.
      if (inWhatWentWrong) {
        if (line.trim() === "") {
          // Blank line inside the block — keep going (could be multi-para).
          continue;
        }
        if (/^\*\s/.test(line)) {
          // Another `* ` block without the Try/help marker — exit.
          inWhatWentWrong = false;
          // Fall through to other checks below.
        } else {
          kept.push(line.trim());
          continue;
        }
      }
      // Failed task line — keep.
      if (TASK_FAILED_RE.test(line)) {
        kept.push(line.trim());
        inFailedTest = false;
        continue;
      }
      // javac diagnostic — keep.
      if (JAVAC_DIAG_RE.test(line)) {
        kept.push(line.trim());
        inFailedTest = false;
        continue;
      }
      // javac `N errors` count — keep.
      if (JAVAC_COUNT_RE.test(line)) {
        kept.push(line.trim());
        inFailedTest = false;
        continue;
      }
      // javac `Note:` lines — drop (deprecation/unchecked notices, not
      // actionable unless there's a preceding error, which we already kept).
      if (JAVAC_NOTE_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Test failure line — keep, set flag for following stack trace.
      if (TEST_FAILED_RE.test(line)) {
        kept.push(line.trim());
        inFailedTest = true;
        continue;
      }
      // Test pass line — drop.
      if (TEST_PASSED_RE.test(line)) {
        noiseDropped++;
        inFailedTest = false;
        continue;
      }
      // Test summary (`N tests completed, M failed`) — keep.
      if (TEST_SUMMARY_RE.test(line)) {
        kept.push(line.trim());
        inFailedTest = false;
        continue;
      }
      // Stack-trace lines — keep only under a failed test.
      if (STACK_TRACE_RE.test(line)) {
        if (inFailedTest) {
          kept.push(line);
        } else {
          noiseDropped++;
        }
        continue;
      }
      // Other indented lines (exception messages like
      // `    java.lang.AssertionError: ...`) — keep as continuation of a
      // failed test, keeping the flag alive so the following `at ...` stack
      // frames are kept too.
      if (inFailedTest && /^\s+/.test(line)) {
        kept.push(line);
        continue;
      }
      // Download noise — drop.
      if (DOWNLOAD_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Config-phase chatter — drop.
      if (CONFIG_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Version / deprecation banners — drop.
      if (BANNER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `> Task :...: NO-SOURCE` — drop.
      if (TASK_NOSOURCE_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Successful `> Task :...` lines — drop (the bulk of the noise).
      if (TASK_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop, reset failed-test flag.
      if (line.trim() === "") {
        inFailedTest = false;
        continue;
      }
      // Unknown line — keep defensively only if it looks like an error.
      if (/\b(error|failed|exception|cannot find)\b/i.test(line)) {
        kept.push(line.trim());
        inFailedTest = false;
        continue;
      }
      noiseDropped++;
      inFailedTest = false;
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
