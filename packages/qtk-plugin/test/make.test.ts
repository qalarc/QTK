// Tests for the make / make build / make install compressor.
//
// Covers:
//   1. matches `make` and `make <target>`
//   2. does NOT match piped/compound commands
//   3. does NOT match non-make commands (cmake, makefile, etc.)
//   4. compresses a failing build — keeps compiler errors + make error
//   5. keeps warnings (actionable) + source-snippet context lines
//   6. drops command echoes (cc -c ..., ar rcs ...)
//   7. clean build with no diagnostics passes through unchanged
//   8. keeps linker errors (undefined reference)
//   9. tiny input passes through
//  10. garbage input passes through
//  11. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { makeCompressor } from "../src/compressors/make.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("make compressor", () => {
  test("matches make and make <target>", () => {
    expect(makeCompressor.matches("bash", { command: "make" })).toBe(true);
    expect(makeCompressor.matches("bash", { command: "make build" })).toBe(
      true,
    );
    expect(makeCompressor.matches("bash", { command: "make install" })).toBe(
      true,
    );
    expect(makeCompressor.matches("bash", { command: "make all" })).toBe(true);
    expect(makeCompressor.matches("bash", { command: "make -j4" })).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(makeCompressor.matches("bash", { command: "make | grep error" })).toBe(
      false,
    );
    expect(makeCompressor.matches("bash", { command: "make && echo ok" })).toBe(
      false,
    );
  });

  test("does NOT match non-make commands", () => {
    expect(makeCompressor.matches("bash", { command: "cmake .." })).toBe(false);
    expect(
      makeCompressor.matches("bash", { command: "makefile parse" }),
    ).toBe(false);
    expect(makeCompressor.matches("bash", { command: "makecert foo" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(makeCompressor.matches("read", { command: "make" })).toBe(false);
  });

  test("compresses a failing build by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/make/build-fail.input.txt", import.meta.url),
    ).text();
    const out = makeCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
    // Compiler errors preserved
    expect(out).toContain("codegen.c:58:5");
    expect(out).toContain("error: unknown type name 'CodegenCtx'");
    expect(out).toContain("codegen.c:91:15");
    expect(out).toContain("STMT_FOR");
    // Make error preserved
    expect(out).toContain("make: *** [Makefile:24: build/codegen.o] Error 1");
    // Command echoes dropped
    expect(out).not.toContain("cc -c -O2");
  });

  test("keeps warnings + source-snippet context lines", () => {
    const input = [
      "cc -c -O2 src/foo.c -o build/foo.o",
      "src/foo.c: In function 'bar':",
      "src/foo.c:10:5: warning: implicit declaration of function 'baz'",
      "   10 |     baz();",
      "      |     ^~~",
      "cc -c -O2 src/main.c -o build/main.o",
    ].join("\n");
    const out = makeCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("warning: implicit declaration");
    // Source snippet kept (follows the diagnostic)
    expect(out).toContain("baz();");
    // Command echo dropped
    expect(out).not.toContain("cc -c -O2 src/foo.c");
  });

  test("clean build with only command echoes passes through unchanged", () => {
    // No diagnostics, no make errors, no success markers → return raw.
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`cc -c -O2 src/file-${i}.c -o build/file-${i}.o`);
    }
    const input = lines.join("\n");
    expect(makeCompressor.compress(input, CTX)).toBe(input);
  });

  test("keeps linker errors (undefined reference)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(`cc -c -O2 src/file-${i}.c -o build/file-${i}.o`);
    }
    lines.push("cc build/*.o -o myapp");
    lines.push("/usr/bin/ld: build/foo.o: in function `bar':");
    lines.push("foo.c:(.text+0x1a): undefined reference to `missing_symbol'");
    lines.push("collect2: error: ld returned 1 exit status");
    lines.push("make: *** [Makefile:30: myapp] Error 1");
    const input = lines.join("\n");
    const out = makeCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("undefined reference to `missing_symbol'");
    expect(out).toContain("collect2: error: ld returned 1 exit status");
    expect(out).toContain("make: *** [Makefile:30: myapp] Error 1");
    // Command echoes dropped
    expect(out).not.toContain("cc -c -O2");
  });

  test("tiny input passes through unchanged", () => {
    const input = "make: nothing to do";
    expect(makeCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not make output\nat all\nnothing useful here\n".repeat(20);
    expect(makeCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k command echoes)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`cc -c -O2 src/file-${i}.c -o build/file-${i}.o`);
    }
    lines.push("src/file-0.c:1:1: error: boom");
    lines.push("make: *** [Makefile:1: all] Error 1");
    const input = lines.join("\n");
    const t0 = performance.now();
    makeCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
