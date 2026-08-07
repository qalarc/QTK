// Tests for the rustc compressor.
//
// Covers:
//   1. matches rustc (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match rustc --version / --print
//   4. does NOT match non-bash tools
//   5. compresses compile output by >= 10%
//   6. keeps error[E0xxx]: diagnostic headers
//   7. keeps the --> file.rs:LINE:COL span locator
//   8. keeps source lines + the ^^^ underline
//   9. keeps note: / help: continuations
//  10. keeps the error: aborting due to N previous errors summary
//  11. keeps warning: lines (with #[warn] lint codes)
//  12. drops the rustc version banner
//  13. tiny input passes through
//  14. garbage input passes through
//  15. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { rustcCompressor } from "../src/compressors/rustc.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("rustc compressor", () => {
  test("matches rustc", () => {
    expect(
      rustcCompressor.matches("bash", { command: "rustc main.rs" }),
    ).toBe(true);
    expect(
      rustcCompressor.matches("bash", { command: "rustc --edition 2021 main.rs" }),
    ).toBe(true);
    expect(
      rustcCompressor.matches("bash", { command: "rustc -O main.rs" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      rustcCompressor.matches("bash", { command: "rustc main.rs | head" }),
    ).toBe(false);
    expect(
      rustcCompressor.matches("bash", { command: "rustc main.rs && ./main" }),
    ).toBe(false);
  });

  test("does NOT match rustc --version / --print", () => {
    expect(
      rustcCompressor.matches("bash", { command: "rustc --version" }),
    ).toBe(false);
    expect(
      rustcCompressor.matches("bash", { command: "rustc --print sysroot" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      rustcCompressor.matches("read", { command: "rustc main.rs" }),
    ).toBe(false);
  });

  test("compresses compile output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps error[E0xxx]: diagnostic headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain("error[E0308]: mismatched types");
    expect(out).toContain("error[E0599]: no method named `nonexistent`");
  });

  test("keeps the --> file.rs:LINE:COL span locator", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain("--> src/main.rs:13:5");
    expect(out).toContain("--> src/main.rs:22:10");
  });

  test("keeps source lines + the ^^^ underline", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain('13 |     let x: i32 = "hello";');
    expect(out).toContain('^^^^^^^ expected `i32`, found `&str`');
    expect(out).toContain("22 |     foo.nonexistent();");
  });

  test("keeps note: / help: continuations", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain("help: consider removing the string literal");
    expect(out).toContain("= note: `#[warn(unused_variables)]` on by default");
  });

  test("keeps the error: aborting due to N previous errors summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain("error: aborting due to 2 previous errors");
  });

  test("keeps warning: lines (with #[warn] lint codes)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).toContain("warning: unused variable: `x`");
    expect(out).toContain("warning: unused imports: `std::collections::HashMap`");
  });

  test("drops the rustc version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rustc/compile.input.txt", import.meta.url),
    ).text();
    const out = rustcCompressor.compress(input, CTX);
    expect(out).not.toContain("rustc 1.78.0");
  });

  test("tiny input passes through unchanged", () => {
    const input = "error[E0308]: bad\n  --> f.rs:1:1\n";
    expect(rustcCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not rustc output\nat all\nnothing useful here\n".repeat(20);
    expect(rustcCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k diagnostics)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`error[E0308]: mismatch ${i}`);
      lines.push(`  --> src/main.rs:${i}:1`);
      lines.push("   |");
      lines.push(`${i} |     let x = "bad";`);
      lines.push("   |          ^^^^^");
      lines.push("");
    }
    lines.push("error: aborting due to 9999 previous errors");
    const input = lines.join("\n");
    const t0 = performance.now();
    rustcCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
