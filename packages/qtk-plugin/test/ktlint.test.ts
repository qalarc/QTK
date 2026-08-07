// Tests for the ktlint compressor.
//
// Covers:
//   1. matches ktlint (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match ktlint --version / --help / --format / -F
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file:line:col: message finding lines
//   7. keeps the Summary errorCount=N penalty=M line
//   8. parses JSON output format
//   9. tiny input passes through
//  10. garbage input passes through
//  11. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { ktlintCompressor } from "../src/compressors/ktlint.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("ktlint compressor", () => {
  test("matches ktlint", () => {
    expect(ktlintCompressor.matches("bash", { command: "ktlint" })).toBe(true);
    expect(ktlintCompressor.matches("bash", { command: "ktlint src/" })).toBe(true);
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint --reporter=plain" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint | grep error" }),
    ).toBe(false);
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint && echo done" }),
    ).toBe(false);
  });

  test("does NOT match ktlint --version / --help / --format / -F", () => {
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint --version" }),
    ).toBe(false);
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint --help" }),
    ).toBe(false);
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint --format" }),
    ).toBe(false);
    expect(
      ktlintCompressor.matches("bash", { command: "ktlint -F" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(ktlintCompressor.matches("read", { command: "ktlint" })).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ktlint/lint.input.txt", import.meta.url),
    ).text();
    const out = ktlintCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file:line:col: message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ktlint/lint.input.txt", import.meta.url),
    ).text();
    const out = ktlintCompressor.compress(input, CTX);
    expect(out).toContain(
      "src/main/kotlin/com/example/File1.kt:3:1: Some ktlint finding number 1",
    );
    expect(out).toContain(
      "src/main/kotlin/com/example/File5.kt:15:5: Some ktlint finding number 5",
    );
    expect(out).toContain(
      "src/main/kotlin/com/example/File10.kt:30:10: Some ktlint finding number 10",
    );
  });

  test("keeps the Summary errorCount=N penalty=M line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ktlint/lint.input.txt", import.meta.url),
    ).text();
    const out = ktlintCompressor.compress(input, CTX);
    expect(out).toContain("Summary errorCount=20 penalty=20");
  });

  test("parses JSON output format", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ktlint/json.input.txt", import.meta.url),
    ).text();
    const out = ktlintCompressor.compress(input, CTX);
    expect(out).toContain(
      "src/main/kotlin/com/example/App.kt:10:1: File name 'App.kt' should conform to the corresponding class name 'Main' (filename)",
    );
    expect(out).toContain(
      "src/main/kotlin/com/example/Service.kt:8:1: Import must be ordered (standard:import-ordering)",
    );
    expect(out).toContain("Summary errorCount=4 penalty=4");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/App.kt:1:1: oops\n";
    expect(ktlintCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not ktlint output\nat all\nnothing useful here\n".repeat(20);
    expect(ktlintCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`src/file${i}.kt:${i}:1: some ktlint finding ${i}`);
    }
    lines.push("Summary errorCount=9999 penalty=9999 (9999 errors need correction)");
    const input = lines.join("\n");
    const t0 = performance.now();
    ktlintCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
