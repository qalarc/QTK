// Tests for the ruff compressor.
//
// Covers:
//   1. matches ruff check (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match ruff --version / ruff format / ruff rule
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file.py:LINE:COL: Exxx message finding lines
//   7. keeps the Found N error(s). summary
//   8. keeps the * Can fix: N auto-fixable count
//   9. drops the View documentation URL epilogue
//  10. tiny input passes through
//  11. garbage input passes through
//  12. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { ruffCompressor } from "../src/compressors/ruff.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("ruff compressor", () => {
  test("matches ruff check", () => {
    expect(
      ruffCompressor.matches("bash", { command: "ruff check ." }),
    ).toBe(true);
    expect(
      ruffCompressor.matches("bash", { command: "ruff check src/" }),
    ).toBe(true);
    expect(
      ruffCompressor.matches("bash", { command: "ruff check --select E501 ." }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      ruffCompressor.matches("bash", { command: "ruff check . | grep E501" }),
    ).toBe(false);
    expect(
      ruffCompressor.matches("bash", { command: "ruff check . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match ruff --version / ruff format / ruff rule", () => {
    expect(
      ruffCompressor.matches("bash", { command: "ruff --version" }),
    ).toBe(false);
    expect(
      ruffCompressor.matches("bash", { command: "ruff format ." }),
    ).toBe(false);
    expect(
      ruffCompressor.matches("bash", { command: "ruff rule E501" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      ruffCompressor.matches("read", { command: "ruff check ." }),
    ).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ruff/check.input.txt", import.meta.url),
    ).text();
    const out = ruffCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.py:LINE:COL: Exxx message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ruff/check.input.txt", import.meta.url),
    ).text();
    const out = ruffCompressor.compress(input, CTX);
    expect(out).toContain("src/app.py:10:5: E999 SyntaxError: invalid syntax");
    expect(out).toContain("src/app.py:15:1: F401 'os' imported but unused");
    expect(out).toContain(
      "src/utils.py:42:80: E501 Line too long (92 > 79 characters)",
    );
    expect(out).toContain(
      "src/models.py:45:1: F811 Redefinition of unused `User` from line 12",
    );
  });

  test("keeps the Found N error(s). summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ruff/check.input.txt", import.meta.url),
    ).text();
    const out = ruffCompressor.compress(input, CTX);
    expect(out).toContain("Found 12 errors.");
  });

  test("keeps the * Can fix: N auto-fixable count", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ruff/check.input.txt", import.meta.url),
    ).text();
    const out = ruffCompressor.compress(input, CTX);
    expect(out).toContain("* Can fix: 8 (8 auto-fixable)");
  });

  test("drops the View documentation URL epilogue", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ruff/check.input.txt", import.meta.url),
    ).text();
    const out = ruffCompressor.compress(input, CTX);
    expect(out).not.toContain("View the full documentation");
    expect(out).not.toContain("View documentation for E711");
    expect(out).not.toContain("https://docs.astral.sh/ruff/rules");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/app.py:1:1: F401 unused\n";
    expect(ruffCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not ruff output\nat all\nnothing useful here\n".repeat(20);
    expect(ruffCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`src/file-${i}.py:${i}:1: E501 Line too long (100 > 79)`);
    }
    lines.push("Found 9999 errors.");
    lines.push("* Can fix: 0 (0 auto-fixable)");
    lines.push("View documentation for E501: https://docs.astral.sh/ruff/rules/line-too-long");
    const input = lines.join("\n");
    const t0 = performance.now();
    ruffCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
