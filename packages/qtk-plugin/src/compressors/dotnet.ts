// `dotnet build` / `dotnet test` compressor.
//
// .NET builds (`dotnet build`, `dotnet test`, `dotnet publish`) route through
// MSBuild, which emits a predictable stream of progress lines:
//   - `MSBuild version 17.x for .NET` — banner, one per (sub)project.
//   - `  Determining projects to restore...` — restore phase chatter.
//   - `  Restored /path/Project.csproj (in 1.23 sec).` — one per project.
//   - `  Project -> /path/bin/Debug/Project.dll` — per-project build link line.
//   - `Test run for .../Tests.dll(...)` + `Starting test execution...` +
//     `A total of N test files matched...` — test runner preamble.
//   - `  Passed Tests.Namespace.TestName [1 ms]` — one per passing test.
//   - `Time Elapsed 00:00:02.34` — timing line.
//
// The signal lives in:
//   - Compiler diagnostics: `path/file.cs(LINE,COL): error CSxxxx: msg` (and
//     `warning CSxxxx:`). The `[/path/Project.csproj]` suffix is dropped for
//     scannability (the file path already identifies the project).
//   - The `N Error(s)` / `N Warning(s)` summary.
//   - Test failures: `  Failed Tests.Namespace.TestName [1 ms]` + the
//     `  Error Message:` block + `  Stack Trace:` block.
//   - The `Passed: N` / `Failed: N` / `Total tests: N` summary.
//   - The `Build FAILED.` / `Build succeeded.` verdict.
//
// Strategy: keep diagnostics (errors + warnings) + the error/warning count +
// test failures (with their error message + stack trace blocks) + the test
// summary + the build verdict; drop restore noise, link lines, passing-test
// lines, banners, and timing chatter.
//
// This compressor is LOSSY: it drops restore noise, per-project link lines,
// passing-test lines, banners, and timing chatter. It is NOT reversible.
// Diagnostics, test failures, and the build/test summaries are preserved.

import type { Compressor } from "../types.ts";

// Compiler diagnostic:
//   `path/file.cs(LINE,COL): error CSxxxx: msg [/path/Project.csproj]`
//   `path/file.cs(LINE,COL): warning CSxxxx: msg [/path/Project.csproj]`
// The `[/path/Project.csproj]` suffix is optional and stripped on keep.
const DIAG_RE =
  /^(?<file>[\w./-]+\.cs)\((?<loc>\d+,\d+)\):\s+(?<severity>error|warning)\s+(?<code>CS\d+):\s+(?<msg>.*?)(?:\s+\[.*?\])?$/;

// `    3 Error(s)` / `    2 Warning(s)` — the count summary. Keep.
const COUNT_RE = /^\s+\d+\s+(Error|Warning)\(s\)/;

// `  Failed Tests.Namespace.TestName [1 ms]` — a failed test. Keep.
const TEST_FAILED_RE = /^\s+Failed\s+[\w.]+\.\w+\b/;

// `  Passed Tests.Namespace.TestName [1 ms]` — a passed test. Drop.
const TEST_PASSED_RE = /^\s+Passed\s+[\w.]+\.\w+\b/;

// `  Error Message:` / `  Stack Trace:` — markers for failed-test detail
// blocks. Keep (and keep the indented content that follows).
const DETAIL_MARKER_RE = /^\s+(Error Message|Stack Trace):/;

// `Passed: N` / `Failed: N` / `Total tests: N` — test summary. Keep.
const TEST_SUMMARY_RE = /^(Passed|Failed|Total tests):/;

// `Build FAILED.` / `Build succeeded.` — verdict. Keep.
const BUILD_VERDICT_RE = /^Build\s+(FAILED|succeeded)\./;

// `MSBuild version ...` banner. Drop.
const MSBUILD_BANNER_RE = /^MSBuild version\s/;

// `  Determining projects to restore...` / `  Restored ...csproj (in ...)`.
const RESTORE_RE = /^\s+(Determining projects|Restored\s)/;

// `  Project -> /path/bin/.../Project.dll` — link line. Drop.
const LINK_RE = /^\s+.*\s->\s+.*\.(dll|exe)$/;

// `Test run for ...` / `Starting test execution...` / `A total of ...` —
// test runner preamble. Drop.
const TEST_PREAMBLE_RE =
  /^(Test run for|Starting test execution|A total of \d+ test)/;

// `Microsoft (R) Test Execution ...` / `Copyright (c) ...` — banners. Drop.
const TEST_BANNER_RE = /^(Microsoft \(R\)|Copyright \(c\))/;

// `Time Elapsed 00:00:02.34` — timing. Drop.
const TIME_RE = /^Time Elapsed\s/;

export const dotnetCompressor: Compressor = {
  name: "dotnet",
  category: "build-tool",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `dotnet build`, `dotnet test`, `dotnet publish`, `dotnet msbuild`.
    // Exclude `dotnet-format`, `dotnet-script` (different tools).
    return /^dotnet\s+(build|test|publish|msbuild)(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State flags:
    //   - inDetail: inside a `Error Message:` or `Stack Trace:` block under a
    //     failed test — keep the indented content lines.
    let inDetail = false;

    for (const line of lines) {
      // Build verdict — always keep, ends detail block.
      if (BUILD_VERDICT_RE.test(line)) {
        kept.push(line.trim());
        inDetail = false;
        continue;
      }
      // Test summary (Passed/Failed/Total) — keep.
      if (TEST_SUMMARY_RE.test(line)) {
        kept.push(line.trim());
        inDetail = false;
        continue;
      }
      // Compiler diagnostic — keep (strip the `[project]` suffix).
      const diagMatch = line.match(DIAG_RE);
      if (diagMatch && diagMatch.groups) {
        kept.push(
          `${diagMatch.groups.file}(${diagMatch.groups.loc}): ${diagMatch.groups.severity} ${diagMatch.groups.code}: ${diagMatch.groups.msg}`,
        );
        inDetail = false;
        continue;
      }
      // Error/Warning count summary — keep.
      if (COUNT_RE.test(line)) {
        kept.push(line.trim());
        inDetail = false;
        continue;
      }
      // Failed test line — keep.
      if (TEST_FAILED_RE.test(line)) {
        kept.push(line.trim());
        inDetail = false;
        continue;
      }
      // Detail marker (`Error Message:` / `Stack Trace:`) — keep, enter block.
      if (DETAIL_MARKER_RE.test(line)) {
        kept.push(line.trim());
        inDetail = true;
        continue;
      }
      // Inside a detail block: keep indented content lines.
      if (inDetail) {
        if (line.trim() === "") {
          // Blank line ends the detail block.
          inDetail = false;
          continue;
        }
        if (/^\s{4,}\S/.test(line)) {
          kept.push(line);
          continue;
        }
        // Non-indented line ends the detail block — fall through.
        inDetail = false;
      }
      // Passed test line — drop.
      if (TEST_PASSED_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Restore noise — drop.
      if (RESTORE_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // MSBuild banner — drop.
      if (MSBUILD_BANNER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Link line — drop.
      if (LINK_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Test preamble — drop.
      if (TEST_PREAMBLE_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Test banner — drop.
      if (TEST_BANNER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Time elapsed — drop.
      if (TIME_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error.
      if (/\b(error|failed|exception)\b/i.test(line)) {
        kept.push(line.trim());
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
