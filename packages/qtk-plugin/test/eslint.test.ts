// Tests for the eslint compressor.
//
// Covers:
//   1. matches eslint / npx eslint (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match eslint --version / --init / --print-config
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file header lines
//   7. keeps LINE:COL severity message rule finding lines
//   8. keeps the ✖ N problems summary
//   9. keeps the fixable hint
//  10. drops the version banner
//  11. drops the documentation URL epilogue
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { eslintCompressor } from "../src/compressors/eslint.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("eslint compressor", () => {
  test("matches eslint / npx eslint", () => {
    expect(eslintCompressor.matches("bash", { command: "eslint ." })).toBe(
      true,
    );
    expect(eslintCompressor.matches("bash", { command: "eslint src/" })).toBe(
      true,
    );
    expect(eslintCompressor.matches("bash", { command: "npx eslint ." })).toBe(
      true,
    );
    expect(
      eslintCompressor.matches("bash", { command: "eslint --ext .ts src/" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      eslintCompressor.matches("bash", { command: "eslint . | grep error" }),
    ).toBe(false);
    expect(
      eslintCompressor.matches("bash", { command: "eslint . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match eslint --version / --init / --print-config", () => {
    expect(
      eslintCompressor.matches("bash", { command: "eslint --version" }),
    ).toBe(false);
    expect(eslintCompressor.matches("bash", { command: "eslint --init" })).toBe(
      false,
    );
    expect(
      eslintCompressor.matches("bash", { command: "eslint --print-config ." }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(eslintCompressor.matches("read", { command: "eslint ." })).toBe(
      false,
    );
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file header lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).toContain("src/app.js");
    expect(out).toContain("src/utils.js");
    expect(out).toContain("src/components/Header.jsx");
    expect(out).toContain("src/index.ts");
  });

  test("keeps LINE:COL severity message rule finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).toContain(
      "10:5   error    'x' is not defined                no-undef",
    );
    expect(out).toContain(
      "15:1   error    Unexpected console statement      no-console",
    );
    expect(out).toContain(
      "42:80  warning  Line exceeds maximum length of 80  max-len",
    );
    expect(out).toContain(
      "8:3   error    Expected ';' and instead saw '}'   semi",
    );
    expect(out).toContain(
      "5:1   error  Type 'string' is not assignable to type 'number'  @typescript-eslint/no-unsafe-assignment",
    );
  });

  test("keeps the ✖ N problems summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).toContain("✖ 11 problems (8 errors, 3 warnings)");
  });

  test("keeps the fixable hint", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).toContain(
      "8 errors and 0 warnings potentially fixable with the `eslint --fix`",
    );
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).not.toContain("ESLint: 9.1.0");
  });

  test("drops the documentation URL epilogue", async () => {
    const input = await Bun.file(
      new URL("./fixtures/eslint/lint.input.txt", import.meta.url),
    ).text();
    const out = eslintCompressor.compress(input, CTX);
    expect(out).not.toContain("View documentation for rule");
    expect(out).not.toContain("https://eslint.org/docs/latest/rules/no-undef");
    expect(out).not.toContain("https://eslint.org/docs/latest/rules/semi");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/app.js\n  1:1  error  oops  no-rule\n";
    expect(eslintCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not eslint output\nat all\nnothing useful here\n".repeat(20);
    expect(eslintCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["src/huge.js"];
    for (let i = 0; i < 9999; i++) {
      lines.push(
        `  ${i}:1  error  some error message here  rule-${i}`,
      );
    }
    lines.push("✖ 9999 problems (9999 errors, 0 warnings)");
    lines.push(
      "  9999 errors and 0 warnings potentially fixable with the `eslint --fix`.",
    );
    lines.push("View documentation for rule: https://eslint.org/docs/latest/rules/rule-0");
    const input = lines.join("\n");
    const t0 = performance.now();
    eslintCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
