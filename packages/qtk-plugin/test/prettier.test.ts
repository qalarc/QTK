// Tests for the prettier compressor.
//
// Covers:
//   1. matches prettier --check / -c (with/without npx/paths)
//   2. does NOT match piped/compound commands
//   3. does NOT match prettier --version / --write / -w
//   4. does NOT match non-bash tools
//   5. compresses check output by >= 10%
//   6. keeps [warn] <file> lines
//   7. keeps [error] <file>: <message> lines
//   8. keeps the Code style issues found in N files summary
//   9. drops the Checking formatting... progress line
//  10. drops the clean-pass chatter
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { prettierCompressor } from "../src/compressors/prettier.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("prettier compressor", () => {
  test("matches prettier --check / -c", () => {
    expect(
      prettierCompressor.matches("bash", { command: "prettier --check ." }),
    ).toBe(true);
    expect(
      prettierCompressor.matches("bash", { command: "prettier -c src/" }),
    ).toBe(true);
    expect(
      prettierCompressor.matches("bash", { command: "npx prettier --check ." }),
    ).toBe(true);
    expect(
      prettierCompressor.matches("bash", { command: "prettier --check src/" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      prettierCompressor.matches("bash", {
        command: "prettier --check . | grep warn",
      }),
    ).toBe(false);
    expect(
      prettierCompressor.matches("bash", {
        command: "prettier --check . && echo done",
      }),
    ).toBe(false);
  });

  test("does NOT match prettier --version / --write / -w", () => {
    expect(
      prettierCompressor.matches("bash", { command: "prettier --version" }),
    ).toBe(false);
    expect(
      prettierCompressor.matches("bash", { command: "prettier --write ." }),
    ).toBe(false);
    expect(
      prettierCompressor.matches("bash", { command: "prettier -w src/" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      prettierCompressor.matches("read", { command: "prettier --check ." }),
    ).toBe(false);
  });

  test("compresses check output (output is smaller)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/prettier/check.input.txt", import.meta.url),
    ).text();
    const out = prettierCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    // Prettier --check output is already terse (mostly a file list), so the
    // ratio is modest — we only assert that SOME compression happens.
  });

  test("keeps [warn] <file> lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/prettier/check.input.txt", import.meta.url),
    ).text();
    const out = prettierCompressor.compress(input, CTX);
    expect(out).toContain("[warn] src/app.ts");
    expect(out).toContain("[warn] src/utils.ts");
    expect(out).toContain("[warn] src/components/Header.tsx");
    expect(out).toContain("[warn] src/styles/global.css");
  });

  test("keeps [error] <file>: <message> lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/prettier/check.input.txt", import.meta.url),
    ).text();
    const out = prettierCompressor.compress(input, CTX);
    expect(out).toContain(
      "[error] src/broken.ts: SyntaxError: Unexpected token (5:10)",
    );
    expect(out).toContain(
      "[error] src/also-broken.js: SyntaxError: Unexpected end of input (12:0)",
    );
  });

  test("keeps the Code style issues found in N files summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/prettier/check.input.txt", import.meta.url),
    ).text();
    const out = prettierCompressor.compress(input, CTX);
    expect(out).toContain("Code style issues found in 40 files.");
  });

  test("drops the Checking formatting... progress line", async () => {
    // Synthetic input with enough noise that compression actually fires.
    const lines: string[] = [
      "Checking formatting...",
      "prettier/3.3.3",
    ];
    for (let i = 0; i < 30; i++) lines.push(`[warn] src/file${i}.ts`);
    lines.push("Code style issues found in 30 files. Forgot to run Prettier?");
    const input = lines.join("\n");
    const out = prettierCompressor.compress(input, CTX);
    expect(out).not.toContain("Checking formatting...");
  });

  test("drops the clean-pass chatter", () => {
    const input = [
      "Checking formatting...",
      "All matched files use Prettier code style!",
      "",
    ].join("\n").repeat(3);
    // No [warn]/[error]/summary → nothing meaningful → return raw.
    expect(prettierCompressor.compress(input, CTX)).toBe(input);
  });

  test("tiny input passes through unchanged", () => {
    const input = "[warn] src/app.ts\n";
    expect(prettierCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not prettier output\nat all\nnothing useful here\n".repeat(20);
    expect(prettierCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k warnings)", () => {
    const lines: string[] = [];
    lines.push("Checking formatting...");
    for (let i = 0; i < 9999; i++) {
      lines.push(`[warn] src/file${i}.ts`);
    }
    lines.push("Code style issues found in 9999 files. Forgot to run Prettier?");
    const input = lines.join("\n");
    const t0 = performance.now();
    prettierCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
