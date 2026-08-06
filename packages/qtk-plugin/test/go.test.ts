// Tests for the go test/build/vet compressor.
//
// Covers:
//   1. matches go test/build/vet/check
//   2. does NOT match piped/compound or unrelated commands
//   3. compresses a failing test run — keeps FAIL lines + summary
//   4. drops === RUN / --- PASS noise
//   5. keeps build errors (./file.go:line:col: format)
//   6. passing run → just the ok summary
//   7. tiny input passes through
//   8. garbage input passes through
//   9. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { goCompressor } from "../src/compressors/go.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("go compressor", () => {
  test("matches go subcommands", () => {
    expect(goCompressor.matches("bash", { command: "go test" })).toBe(true);
    expect(goCompressor.matches("bash", { command: "go test ./..." })).toBe(
      true,
    );
    expect(goCompressor.matches("bash", { command: "go build" })).toBe(true);
    expect(goCompressor.matches("bash", { command: "go vet ./..." })).toBe(
      true,
    );
    expect(goCompressor.matches("bash", { command: "go check" })).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(goCompressor.matches("bash", { command: "go test | grep FAIL" })).toBe(
      false,
    );
    expect(goCompressor.matches("bash", { command: "go test && echo ok" })).toBe(
      false,
    );
  });

  test("does NOT match unrelated go commands", () => {
    expect(goCompressor.matches("bash", { command: "go run main.go" })).toBe(
      false,
    );
    expect(goCompressor.matches("bash", { command: "go fmt" })).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(goCompressor.matches("read", { command: "go test" })).toBe(false);
  });

  test("compresses a failing test run by >= 50%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go/test-fail.input.txt", import.meta.url),
    ).text();
    const out = goCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.5); // at least 50% reduction
    // Summary preserved
    expect(out).toContain("FAIL");
    expect(out).toContain("github.com/example/math");
    expect(out).toContain("ok");
    expect(out).toContain("github.com/example/utils");
    // The failing test is kept
    expect(out).toContain("TestDivide");
    // RUN/PASS noise dropped
    expect(out).not.toContain("=== RUN");
    expect(out).not.toContain("--- PASS");
  });

  test("passing run → just the ok summary", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`=== RUN   TestPass${i}`);
      lines.push(`--- PASS: TestPass${i} (0.00s)`);
    }
    lines.push("PASS");
    lines.push("ok  \tgithub.com/example/pkg\t0.456s");
    const input = lines.join("\n");
    const out = goCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("ok");
    expect(out).toContain("github.com/example/pkg");
    expect(out).toContain("PASS");
    // RUN noise dropped
    expect(out).not.toContain("=== RUN");
    expect(out).not.toContain("--- PASS");
  });

  test("keeps build errors in ./file.go:line:col: format", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`=== RUN   TestThing${i}`);
      lines.push(`--- PASS: TestThing${i} (0.00s)`);
    }
    lines.push("# github.com/example/pkg");
    lines.push("./pkg/handler.go:42:5: undefined: someFunc");
    lines.push("./pkg/handler.go:58:2: undefined: otherFunc");
    lines.push("FAIL\tgithub.com/example/pkg [build failed]");
    const input = lines.join("\n");
    const out = goCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("handler.go:42:5");
    expect(out).toContain("undefined: someFunc");
    expect(out).toContain("build failed");
  });

  test("tiny input passes through unchanged", () => {
    const input = "ok  github.com/foo 0.1s";
    expect(goCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not go output\nat all\nnothing useful here\n".repeat(20);
    expect(goCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k RUN lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(`=== RUN   TestAdversarial${i}`);
    }
    lines.push("PASS");
    lines.push("ok  \tgithub.com/example/big\t1.234s");
    const input = lines.join("\n");
    const t0 = performance.now();
    goCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
