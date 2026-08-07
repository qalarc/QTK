// Tests for the golangci-lint compressor.
//
// Covers:
//   1. matches golangci-lint run / bare golangci-lint (with/without args)
//   2. does NOT match piped/compound commands
//   3. does NOT match golangci-lint --version / linters / config / cache / help
//   4. does NOT match go vet (handled by the go-vet compressor)
//   5. does NOT match non-bash tools
//   6. compresses lint output by >= 10%
//   7. keeps file.go:LINE:COL: <code>: msg (<linter>) finding lines
//   8. keeps the (<linter>) continuation tag on its own line
//   9. keeps level=error / level=warning markers
//  10. keeps the N issues summary
//  11. drops the version banner
//  12. drops level=info chatter
//  13. drops the Running [linters]... progress line
//  14. tiny input passes through
//  15. garbage input passes through
//  16. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { golangciLintCompressor } from "../src/compressors/golangci-lint.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("golangci-lint compressor", () => {
  test("matches golangci-lint run / bare golangci-lint", () => {
    expect(
      golangciLintCompressor.matches("bash", { command: "golangci-lint run" }),
    ).toBe(true);
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint run ./...",
      }),
    ).toBe(true);
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint run -E staticcheck",
      }),
    ).toBe(true);
    expect(
      golangciLintCompressor.matches("bash", { command: "golangci-lint" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint run | grep staticcheck",
      }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint run && echo done",
      }),
    ).toBe(false);
  });

  test("does NOT match golangci-lint --version / linters / config / cache / help", () => {
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint --version",
      }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint version",
      }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", {
        command: "golangci-lint linters",
      }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", { command: "golangci-lint cache" }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", { command: "golangci-lint help" }),
    ).toBe(false);
  });

  test("does NOT match go vet (handled by go-vet compressor)", () => {
    expect(
      golangciLintCompressor.matches("bash", { command: "go vet ./..." }),
    ).toBe(false);
    expect(
      golangciLintCompressor.matches("bash", { command: "go tool vet ." }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      golangciLintCompressor.matches("read", { command: "golangci-lint run" }),
    ).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.go:LINE:COL: <code>: msg (<linter>) finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).toContain(
      "main.go:23:2: G104: Errors unhandled. (errcheck)",
    );
    expect(out).toContain(
      "main.go:42:5: ineffectual assignment to err (ineffassign)",
    );
    expect(out).toContain(
      "handler.go:10:18: Error return value of `w.Write` is not checked (errcheck)",
    );
    expect(out).toContain(
      "service.go:12:2: `config` is unused (unused)",
    );
  });

  test("keeps the (<linter>) continuation tag on its own line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    // The S1000 finding wraps the (staticcheck) tag onto the next line.
    expect(out).toContain(
      "main.go:15:6: S1000: should use a simple channel iteration",
    );
    expect(out).toContain("(staticcheck)");
    expect(out).toContain("(gocyclo)");
    expect(out).toContain("(govet)");
  });

  test("keeps level=error / level=warning markers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).toContain(
      'level=warning msg="[linters] this linter is deprecated: scopelint (deprecated, replaced by exportloopref)"',
    );
    expect(out).toContain(
      'level=error msg="[runner] Panic: test panic on input: stack trace goroutine 1 [running]:"',
    );
  });

  test("keeps the N issues summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).toContain("8 issues:");
    expect(out).toContain("(8 errors, 0 warnings)");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).not.toContain("golangci-lint has version 1.59.1");
  });

  test("drops level=info chatter", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).not.toContain("level=info");
    expect(out).not.toContain("[config] golangci-lint config file found");
    expect(out).not.toContain("[runner] worker 1 allocated");
  });

  test("drops the Running [linters]... progress line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/golangci-lint/run.input.txt", import.meta.url),
    ).text();
    const out = golangciLintCompressor.compress(input, CTX);
    expect(out).not.toContain("Running [staticcheck");
  });

  test("tiny input passes through unchanged", () => {
    const input = "main.go:1:1: X1: oops (staticcheck)\n";
    expect(golangciLintCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not golangci-lint output\nat all\nnothing useful here\n".repeat(
        20,
      );
    expect(golangciLintCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [
      "golangci-lint has version 1.59.1",
      'level=info msg="[runner] worker 1 allocated"',
      "Running [staticcheck] ...",
      "",
    ];
    for (let i = 0; i < 9999; i++) {
      lines.push(`main.go:${i}:1: G104: unhandled error ${i} (errcheck)`);
    }
    lines.push("9999 issues:");
    const input = lines.join("\n");
    const t0 = performance.now();
    golangciLintCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
