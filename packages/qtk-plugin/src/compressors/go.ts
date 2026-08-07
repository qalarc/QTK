// `go test` / `go build` / `go vet` compressor.
//
// Go toolchain output is verbose in predictable ways:
//   - `go build`: prints nothing on success, but on failure emits
//     `./pkg/foo.go:42:5: undefined: bar` style errors
//   - `go test`: prints `=== RUN`/`--- PASS`/`--- FAIL` per test, then
//     `PASS`/`FAIL` + `ok/FAIL package 1.23s` summary
//   - `go vet`: prints `./file.go:line: message` diagnostics
//
// For the model:
//   - On success: just the `ok`/`PASS` summary line
//   - On failure: the `--- FAIL` lines + build/vet errors
//   - `=== RUN`/`--- PASS` lines are noise (hundreds on a big suite)
//
// Strategy: keep summary + failures + errors, drop per-test RUN/PASS noise.

import type { Compressor } from "../types.ts";

// Summary lines we always keep.
// `ok  \tgithub.com/foo/bar\t1.234s` or `ok  \tgithub.com/foo/bar\t[no tests to run]`
const OK_RE = /^ok\s+/;
// `FAIL\tpackage\t1.234s`
const FAIL_PKG_RE = /^FAIL\s+/;
// Bare `PASS` / `FAIL` / `FAIL\t` final markers.
const PASS_RE = /^(PASS|FAIL)\b/;
// `--- FAIL: TestName` or `--- FAIL   TestName`
const TEST_FAIL_RE = /^---\s+FAIL/;
// `--- PASS` / `--- SKIP` — per-test noise.
const TEST_PASS_RE = /^---\s+(PASS|SKIP)\b/;
// `=== RUN` / `=== NAME` / `=== CONT` — per-test noise.
const RUN_RE = /^===\s+(RUN|NAME|CONT|PAUSE)\b/;
// Build/vet error: `./path/file.go:line:col: message` or `path/file.go:line: message`
const DIAG_RE = /^(\.\/)?[\w/.-]+\.go:\d+(:\d+)?:\s/;
// `# package-path` build-failure section header.
const BUILD_ERR_RE = /^#\s+\S/;
// `panic:` lines are critical.
const PANIC_RE = /^panic:/;
// `go: error` / `go: warning` toolchain messages.
const GO_MSG_RE = /^go:\s+(error|warning)\b/i;

export const goCompressor: Compressor = {
  name: "go",
  category: "test-runner",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `go vet` is handled by the dedicated `go-vet` compressor (registered
    // before this one, first-match wins). Exclude it here so the two don't
    // overlap. `go check` is an alias-ish for vet in some toolchains — also
    // excluded.
    if (/^go\s+(vet|tool\s+vet|check)\b/.test(cmd)) return false;
    return /^go\s+(test|build)\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const summary: string[] = [];
    const failures: string[] = [];
    const errors: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // Summary lines — always keep.
      if (OK_RE.test(line) || FAIL_PKG_RE.test(line) || PASS_RE.test(line)) {
        summary.push(line.trim());
        continue;
      }
      // Test failures — keep.
      if (TEST_FAIL_RE.test(line)) {
        failures.push(line.trim());
        continue;
      }
      // Panics — critical, keep.
      if (PANIC_RE.test(line)) {
        failures.push(line.trim());
        continue;
      }
      // Build/vet diagnostics — keep.
      if (DIAG_RE.test(line) || BUILD_ERR_RE.test(line)) {
        errors.push(line.trim());
        continue;
      }
      // Go toolchain errors/warnings — keep.
      if (GO_MSG_RE.test(line)) {
        errors.push(line.trim());
        continue;
      }
      // Per-test RUN/PASS/SKIP noise — drop.
      if (RUN_RE.test(line) || TEST_PASS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep only if it looks like a continuation of a
      // diagnostic (indented, or contains a colon-something pattern).
      // Otherwise drop as noise. Conservative: drop unknowns because go
      // output is highly structured and unknown lines are usually
      // sub-test indentation or race-detector stack noise.
      noiseDropped++;
    }

    // If we found nothing meaningful, return raw.
    if (
      summary.length === 0 &&
      failures.length === 0 &&
      errors.length === 0
    ) {
      return raw;
    }

    const out: string[] = [];
    if (summary.length > 0) {
      out.push(summary.join("\n"));
    }
    if (errors.length > 0) {
      out.push("");
      out.push(`${errors.length} error(s):`);
      out.push(...errors.slice(0, 20));
      if (errors.length > 20) out.push(`... +${errors.length - 20} more`);
    }
    if (failures.length > 0) {
      out.push("");
      out.push(`${failures.length} failure(s):`);
      out.push(...failures.slice(0, 20));
      if (failures.length > 20) out.push(`... +${failures.length - 20} more`);
    }
    if (noiseDropped > 0) {
      out.push(`(${noiseDropped} RUN/PASS lines dropped)`);
    }

    const result = out.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
