// Tests for the pylint compressor.
//
// Covers:
//   1. matches pylint / python -m pylint (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match pylint --version
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file.py:LINE:COL: LNNNN: message (symbolic) finding lines
//   7. keeps the ************* Module headers
//   8. keeps the Your code has been rated at X/10 rating line
//   9. drops the decorative borders
//  10. drops the Report block + statements analysed
//  11. drops watch-mode chatter
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { pylintCompressor } from "../src/compressors/pylint.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("pylint compressor", () => {
  test("matches pylint / python -m pylint", () => {
    expect(pylintCompressor.matches("bash", { command: "pylint src/" })).toBe(
      true,
    );
    expect(pylintCompressor.matches("bash", { command: "pylint ." })).toBe(
      true,
    );
    expect(
      pylintCompressor.matches("bash", { command: "pylint --disable=C0114 src/" }),
    ).toBe(true);
    expect(
      pylintCompressor.matches("bash", { command: "python -m pylint ." }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      pylintCompressor.matches("bash", { command: "pylint src/ | grep W0612" }),
    ).toBe(false);
    expect(
      pylintCompressor.matches("bash", { command: "pylint . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match pylint --version", () => {
    expect(
      pylintCompressor.matches("bash", { command: "pylint --version" }),
    ).toBe(false);
    expect(
      pylintCompressor.matches("bash", { command: "python -m pylint --version" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(pylintCompressor.matches("read", { command: "pylint ." })).toBe(
      false,
    );
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.py:LINE:COL: LNNNN: message (symbolic) finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out).toContain(
      "src\\app.py:10:8: C0103: Class name 'foo' doesn't conform to PascalCase naming style (invalid-name)",
    );
    expect(out).toContain(
      "src\\app.py:22:0: E1101: Module 'os' has no 'nonexistent' member (no-member)",
    );
    expect(out).toContain(
      "src\\app.py:30:15: E0602: Undefined variable 'missing_var' (undefined-variable)",
    );
    expect(out).toContain(
      "src\\utils.py:20:4: W0703: Catching too general exception Exception (broad-except)",
    );
    expect(out).toContain(
      "src\\handlers.py:20:4: W0102: Dangerous default value [] as argument (dangerous-default-value)",
    );
  });

  test("keeps the ************* Module headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out).toContain("************* Module src.app");
    expect(out).toContain("************* Module src.utils");
    expect(out).toContain("************* Module src.models");
    expect(out).toContain("************* Module src.handlers");
  });

  test("keeps the Your code has been rated at X/10 rating line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out).toContain("Your code has been rated at 4.25/10");
  });

  test("drops the decorative borders", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    // The `---...` border around the rating should be gone.
    expect(out).not.toMatch(/\n-{10,}\n/);
  });

  test("drops the Report block + statements analysed", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out).not.toContain("Report");
    expect(out).not.toContain("16 statements analysed.");
  });

  test("drops watch-mode chatter", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pylint/lint.input.txt", import.meta.url),
    ).text();
    const out = pylintCompressor.compress(input, CTX);
    expect(out).not.toContain("Watch mode is enabled");
    expect(out).not.toContain("Watching for file changes");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/app.py:1:1: C0103: oops (invalid-name)\n";
    expect(pylintCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not pylint output\nat all\nnothing useful here\n".repeat(20);
    expect(pylintCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      if (i % 50 === 0) lines.push(`************* Module src.mod${i}`);
      lines.push(
        `src/file${i}.py:${i}:1: C0103: some pylint finding ${i} (symbolic-${i})`,
      );
    }
    lines.push("Your code has been rated at 1.00/10");
    lines.push("Report");
    lines.push("======");
    lines.push("9999 statements analysed.");
    const input = lines.join("\n");
    const t0 = performance.now();
    pylintCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
