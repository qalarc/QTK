// Tests for the mypy compressor.
//
// Covers:
//   1. matches mypy / python -m mypy (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match mypy --version
//   4. does NOT match non-bash tools
//   5. compresses type-check output by >= 10%
//   6. keeps file.py:LINE: error: msg [code] finding lines
//   7. keeps note: continuation lines
//   8. keeps the Found N errors summary
//   9. keeps Success: no issues found (clean pass)
//  10. drops the version banner
//  11. drops the Use --... hint lines
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { mypyCompressor } from "../src/compressors/mypy.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("mypy compressor", () => {
  test("matches mypy / python -m mypy", () => {
    expect(mypyCompressor.matches("bash", { command: "mypy ." })).toBe(true);
    expect(mypyCompressor.matches("bash", { command: "mypy src/" })).toBe(true);
    expect(mypyCompressor.matches("bash", { command: "mypy --strict ." })).toBe(
      true,
    );
    expect(mypyCompressor.matches("bash", { command: "python -m mypy ." })).toBe(
      true,
    );
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      mypyCompressor.matches("bash", { command: "mypy . | grep error" }),
    ).toBe(false);
    expect(
      mypyCompressor.matches("bash", { command: "mypy . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match mypy --version", () => {
    expect(mypyCompressor.matches("bash", { command: "mypy --version" })).toBe(
      false,
    );
    expect(
      mypyCompressor.matches("bash", { command: "python -m mypy --version" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(mypyCompressor.matches("read", { command: "mypy ." })).toBe(false);
  });

  test("compresses type-check output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.py:LINE: error: msg [code] finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    expect(out).toContain(
      'src/app.py:10: error: Name "foo" is not defined  [name-defined]',
    );
    expect(out).toContain(
      'src/app.py:15: error: Argument 1 to "process" has incompatible type "str"; expected "int"  [arg-type]',
    );
    expect(out).toContain(
      'src/utils.py:42: error: Incompatible return value type (got "str", expected "int")  [return-value]',
    );
    expect(out).toContain(
      'src/handlers.py:30: error: Unsupported operand types for + ("int" and "str")  [operator]',
    );
  });

  test("keeps note: continuation lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    // The "note: See https://..." line is a real note (not a Use -- hint).
    expect(out).toContain(
      "note: See https://mypy.readthedocs.io/en/latest/running_mypy.html#missing-imports",
    );
  });

  test("keeps the Found N errors summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    expect(out).toContain("Found 11 errors in 5 files (checked 12 source files)");
  });

  test("keeps Success: no issues found (clean pass)", () => {
    // Pad with realistic mypy preamble so the input clears the 200-byte guard.
    const input = `mypy 1.10.0 (compiled)
config: reading pyproject.toml
config: loaded 42 source files
analyzing 42 source files
checking src/app.py
checking src/utils.py
checking src/models.py
checking src/handlers.py
checking src/config.py
checking src/services/auth.py
checking src/services/cache.py

Success: no issues found  (0 errors)
`;
    const out = mypyCompressor.compress(input, CTX);
    expect(out).toContain("Success: no issues found");
    expect(out).not.toContain("mypy 1.10.0");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    expect(out).not.toContain("mypy 1.10.0");
  });

  test("drops the Use --... hint lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mypy/check.input.txt", import.meta.url),
    ).text();
    const out = mypyCompressor.compress(input, CTX);
    expect(out).not.toContain("Use --warn-unused-ignores");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/app.py:1: error: oops [code-1]\n";
    expect(mypyCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not mypy output\nat all\nnothing useful here\n".repeat(20);
    expect(mypyCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["mypy 1.10.0 (compiled)", ""];
    for (let i = 0; i < 9999; i++) {
      lines.push(`src/file-${i}.py:${i}: error: some type error  [code-${i}]`);
      lines.push(
        `src/file-${i}.py:${i}: note: Use --warn-unused-ignores to see ...`,
      );
    }
    lines.push("Found 9999 errors in 9999 files (checked 9999 source files)");
    const input = lines.join("\n");
    const t0 = performance.now();
    mypyCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
