// Tests for the gcc compressor.
//
// Covers:
//   1. matches gcc / g++ / clang / clang++ / cc (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match gcc --version / -v / -dumpversion / -print-*
//   4. does NOT match non-bash tools
//   5. compresses compile output by >= 10%
//   6. keeps file.c:LINE:COL: error:/warning:/note: diagnostic headers
//   7. keeps source-snippet lines + the ^~~ caret underline
//   8. keeps the N warnings/errors generated. summary
//   9. keeps linker errors (undefined reference / cannot find -l / ld returned)
//  10. drops the version banner
//  11. drops the compiler invocation echo
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { gccCompressor } from "../src/compressors/gcc.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("gcc compressor", () => {
  test("matches gcc / g++ / clang / clang++ / cc", () => {
    expect(gccCompressor.matches("bash", { command: "gcc main.c" })).toBe(true);
    expect(gccCompressor.matches("bash", { command: "g++ -o app app.cpp" })).toBe(
      true,
    );
    expect(gccCompressor.matches("bash", { command: "clang -c src.c" })).toBe(
      true,
    );
    expect(gccCompressor.matches("bash", { command: "clang++ src.mm" })).toBe(
      true,
    );
    expect(gccCompressor.matches("bash", { command: "cc -O2 main.c" })).toBe(
      true,
    );
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      gccCompressor.matches("bash", { command: "gcc main.c | head" }),
    ).toBe(false);
    expect(
      gccCompressor.matches("bash", { command: "gcc main.c && ./a.out" }),
    ).toBe(false);
  });

  test("does NOT match gcc --version / -v / -dumpversion / -print-*", () => {
    expect(
      gccCompressor.matches("bash", { command: "gcc --version" }),
    ).toBe(false);
    expect(gccCompressor.matches("bash", { command: "gcc -v" })).toBe(false);
    expect(
      gccCompressor.matches("bash", { command: "gcc -dumpversion" }),
    ).toBe(false);
    expect(
      gccCompressor.matches("bash", { command: "gcc -print-libgcc-file-name" }),
    ).toBe(false);
    expect(
      gccCompressor.matches("bash", { command: "clang --version" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(gccCompressor.matches("read", { command: "gcc main.c" })).toBe(false);
  });

  test("compresses compile output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.c:LINE:COL: error:/warning:/note: diagnostic headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).toContain(
      "main.c:5:7: warning: unused variable 'count' [-Wunused-variable]",
    );
    expect(out).toContain(
      "main.c:12:10: error: use of undeclared identifier 'missing_var'",
    );
    expect(out).toContain(
      "main.c:3:6: note: previous declaration is here",
    );
  });

  test("keeps source-snippet lines + the ^~~ caret underline", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).toContain("5 |   int count = 0;");
    expect(out).toContain("|       ^~~~~");
    expect(out).toContain("12 |   return missing_var;");
  });

  test("keeps the N warnings/errors generated. summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).toContain("2 warnings and 3 errors generated.");
  });

  test("keeps linker errors (undefined reference / cannot find -l / ld returned)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).toContain("undefined reference to `compute'");
    expect(out).toContain("undefined reference to `helper_function'");
    expect(out).toContain("cannot find -lcustomlib: No such file or directory");
    expect(out).toContain("collect2: error: ld returned 1 exit status");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).not.toContain("clang version 18.1.8");
    expect(out).not.toContain("Target:");
    expect(out).not.toContain("Thread model:");
  });

  test("drops the compiler invocation echo", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gcc/compile.input.txt", import.meta.url),
    ).text();
    const out = gccCompressor.compress(input, CTX);
    expect(out).not.toContain("-cc1");
    expect(out).not.toContain("-resource-dir");
  });

  test("tiny input passes through unchanged", () => {
    const input = "main.c:1:1: error: oops\n";
    expect(gccCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not gcc output\nat all\nnothing useful here\n".repeat(20);
    expect(gccCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k diagnostics)", () => {
    const lines: string[] = ["clang version 18.1.8", "Target: x86_64", ""];
    for (let i = 0; i < 9999; i++) {
      lines.push(`main.c:${i}:1: error: some compile error ${i}`);
      lines.push(`   ${i} |   int x = 0;`);
      lines.push("     |       ^");
    }
    lines.push("9999 errors generated.");
    const input = lines.join("\n");
    const t0 = performance.now();
    gccCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
