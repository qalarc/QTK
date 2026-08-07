// Tests for the pytest-v compressor (verbose mode).
//
// Covers:
//   1. matches pytest -v / --verbose / -vv / -vs / python -m pytest -v
//   2. does NOT match plain pytest (no -v) — that's the generic pytest compressor
//   3. does NOT match piped/compound commands
//   4. does NOT match non-bash tools
//   5. green run → just the summary (PASSED lines dropped)
//   6. red run → keeps FAILED lines + tracebacks + summary
//   7. drops PASSED lines on a green run
//   8. drops SKIPPED lines (count is in summary)
//   9. keeps collection errors
//  10. tiny input passes through
//  11. garbage input passes through
//  12. adversarial input doesn't hang
//  13. registry: pytest-v wins over pytest when -v present

import { describe, test, expect } from "bun:test";
import { pytestVCompressor } from "../src/compressors/pytest-v.ts";
import { pytestCompressor } from "../src/compressors/pytest.ts";
import { CompressorRegistry } from "../src/registry.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("pytest-v compressor", () => {
  test("matches pytest -v / --verbose / -vv / -vs", () => {
    expect(pytestVCompressor.matches("bash", { command: "pytest -v" })).toBe(
      true,
    );
    expect(
      pytestVCompressor.matches("bash", { command: "pytest --verbose" }),
    ).toBe(true);
    expect(pytestVCompressor.matches("bash", { command: "pytest -vv" })).toBe(
      true,
    );
    expect(pytestVCompressor.matches("bash", { command: "pytest -vs" })).toBe(
      true,
    );
    expect(
      pytestVCompressor.matches("bash", { command: "pytest -v tests/" }),
    ).toBe(true);
    expect(
      pytestVCompressor.matches("bash", { command: "python -m pytest -v" }),
    ).toBe(true);
    expect(
      pytestVCompressor.matches("bash", {
        command: "python -m pytest --verbose tests/",
      }),
    ).toBe(true);
  });

  test("does NOT match plain pytest (no -v) — generic pytest handles that", () => {
    expect(pytestVCompressor.matches("bash", { command: "pytest" })).toBe(
      false,
    );
    expect(
      pytestVCompressor.matches("bash", { command: "pytest tests/" }),
    ).toBe(false);
    expect(
      pytestVCompressor.matches("bash", { command: "python -m pytest" }),
    ).toBe(false);
    // Confirm the generic pytest compressor DOES match these.
    expect(pytestCompressor.matches("bash", { command: "pytest" })).toBe(true);
    expect(
      pytestCompressor.matches("bash", { command: "pytest tests/" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      pytestVCompressor.matches("bash", { command: "pytest -v | grep FAIL" }),
    ).toBe(false);
    expect(
      pytestVCompressor.matches("bash", { command: "pytest -v && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(pytestVCompressor.matches("read", { command: "pytest -v" })).toBe(
      false,
    );
  });

  test("green run → just the summary (PASSED lines dropped)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pytest-v/green.input.txt", import.meta.url),
    ).text();
    const out = pytestVCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("8 passed");
    expect(out).toContain("1.42s");
    // PASSED lines must be gone.
    expect(out).not.toContain("PASSED");
    // The per-test node ids must be gone.
    expect(out).not.toContain("test_add");
    expect(out).not.toContain("test_concat");
  });

  test("red run → keeps FAILED lines + tracebacks + summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/pytest-v/red.input.txt", import.meta.url),
    ).text();
    const out = pytestVCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("2 failed");
    expect(out).toContain("3 passed");
    // Failed test names preserved.
    expect(out).toContain("test_subtraction");
    expect(out).toContain("test_division");
    // Traceback detail preserved.
    expect(out).toContain("assert 5 == 4");
    expect(out).toContain("ZeroDivisionError");
    // PASSED lines dropped.
    expect(out).not.toContain("test_addition PASSED");
    expect(out).not.toContain("test_multiplication PASSED");
  });

  test("drops SKIPPED lines (count is in summary)", () => {
    const input = `============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0
collected 3 items

tests/test_skip.py::test_one PASSED [ 33%]
tests/test_skip.py::test_two SKIPPED (reason) [ 66%]
tests/test_skip.py::test_three PASSED [100%]

========================= 2 passed, 1 skipped in 0.10s =========================
`;
    const out = pytestVCompressor.compress(input, CTX);
    expect(out).toContain("2 passed, 1 skipped");
    expect(out).not.toContain("SKIPPED");
  });

  test("keeps collection errors", () => {
    const input = `============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0
collected 0 items / 1 error

==================================== ERRORS ====================================
_________________________ ERROR collecting tests/test_bad.py _________________________
ImportError: cannot import name 'foo' from 'bar'
========================== short test summary info ============================
ERROR tests/test_bad.py - ImportError: cannot import name 'foo'
========================= 1 error in 0.05s =========================
`;
    const out = pytestVCompressor.compress(input, CTX);
    expect(out).toContain("1 error");
    expect(out).toContain("ERROR collecting");
    expect(out).toContain("ImportError");
  });

  test("tiny input passes through unchanged", () => {
    const input = "tests/foo.py::test_bar PASSED [100%]\n";
    expect(pytestVCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not pytest output\nat all\nnothing useful here\n".repeat(20);
    expect(pytestVCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k PASSED lines)", () => {
    const lines: string[] = [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.11.4, pytest-7.4.0",
      "collected 10000 items",
      "",
    ];
    for (let i = 0; i < 9999; i++) {
      lines.push(`tests/test_big.py::test_${i} PASSED [${i}%]`);
    }
    lines.push("");
    lines.push("=========================== 9999 passed in 12.3s ============================");
    const input = lines.join("\n");
    const t0 = performance.now();
    const out = pytestVCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
    // Should compress massively (only summary survives).
    expect(out.length).toBeLessThan(input.length * 0.05);
    expect(out).toContain("9999 passed");
  });

  test("registry: pytest-v wins over pytest when -v present", () => {
    const reg = new CompressorRegistry();
    const c = reg.lookup("bash", { command: "pytest -v" });
    expect(c).not.toBeNull();
    expect(c!.name).toBe("pytest-v");
    // Without -v, the generic pytest compressor wins.
    const c2 = reg.lookup("bash", { command: "pytest" });
    expect(c2).not.toBeNull();
    expect(c2!.name).toBe("pytest");
  });
});
