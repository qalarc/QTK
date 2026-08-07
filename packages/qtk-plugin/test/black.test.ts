// Tests for the black compressor.
//
// Covers:
//   1. matches black --check (with/without python -m / paths)
//   2. does NOT match piped/compound commands
//   3. does NOT match black --version / bare black . (mutating)
//   4. does NOT match non-bash tools
//   5. compresses check output (output is smaller)
//   6. keeps would reformat <file> lines
//   7. keeps error: cannot format <file>: <message> lines
//   8. keeps the N files would be reformatted. summary
//   9. drops the Oh no! decoration
//  10. drops the All done! clean-pass chatter
//  11. drops the N files left unchanged. line
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { blackCompressor } from "../src/compressors/black.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("black compressor", () => {
  test("matches black --check", () => {
    expect(
      blackCompressor.matches("bash", { command: "black --check ." }),
    ).toBe(true);
    expect(
      blackCompressor.matches("bash", { command: "black --check src/" }),
    ).toBe(true);
    expect(
      blackCompressor.matches("bash", { command: "python -m black --check ." }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      blackCompressor.matches("bash", {
        command: "black --check . | grep reformat",
      }),
    ).toBe(false);
    expect(
      blackCompressor.matches("bash", { command: "black --check . && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match black --version / bare black . (mutating)", () => {
    expect(
      blackCompressor.matches("bash", { command: "black --version" }),
    ).toBe(false);
    expect(
      blackCompressor.matches("bash", { command: "black ." }),
    ).toBe(false);
    expect(
      blackCompressor.matches("bash", { command: "black src/" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      blackCompressor.matches("read", { command: "black --check ." }),
    ).toBe(false);
  });

  test("compresses check output (output is smaller)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/black/check.input.txt", import.meta.url),
    ).text();
    const out = blackCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    // Black --check output is already terse (mostly a file list), so the
    // ratio is modest — we only assert that SOME compression happens.
  });

  test("keeps would reformat <file> lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/black/check.input.txt", import.meta.url),
    ).text();
    const out = blackCompressor.compress(input, CTX);
    expect(out).toContain("would reformat src/app.py");
    expect(out).toContain("would reformat src/utils.py");
    expect(out).toContain("would reformat src/db/connection.py");
    expect(out).toContain("would reformat src/tests/test_app.py");
  });

  test("keeps error: cannot format <file>: <message> lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/black/check.input.txt", import.meta.url),
    ).text();
    const out = blackCompressor.compress(input, CTX);
    expect(out).toContain(
      "error: cannot format src/broken.py: Cannot parse: 5:10: unexpected token 'return'",
    );
    expect(out).toContain(
      "error: cannot format src/also_broken.py: Cannot parse: 12:0: unexpected EOF while parsing",
    );
  });

  test("keeps the N files would be reformatted. summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/black/check.input.txt", import.meta.url),
    ).text();
    const out = blackCompressor.compress(input, CTX);
    expect(out).toContain("27 files would be reformatted.");
  });

  test("drops the Oh no! decoration", async () => {
    const input = await Bun.file(
      new URL("./fixtures/black/check.input.txt", import.meta.url),
    ).text();
    const out = blackCompressor.compress(input, CTX);
    expect(out).not.toMatch(/^Oh no!/m);
  });

  test("drops the All done! clean-pass chatter", () => {
    const input = [
      "All done! ✨ 🍰 ✨",
      "3 files left unchanged.",
      "",
    ].join("\n").repeat(3);
    // No would-reformat/error/summary → nothing meaningful → return raw.
    expect(blackCompressor.compress(input, CTX)).toBe(input);
  });

  test("drops the N files left unchanged. line", () => {
    // Synthetic input with enough signal + noise that compression fires.
    const lines: string[] = [
      "All done! ✨ 🍰 ✨",
      "3 files left unchanged.",
    ];
    for (let i = 0; i < 30; i++) lines.push(`would reformat src/file${i}.py`);
    lines.push("30 files would be reformatted.");
    const input = lines.join("\n");
    const out = blackCompressor.compress(input, CTX);
    expect(out).not.toContain("files left unchanged.");
    expect(out).not.toContain("All done!");
  });

  test("tiny input passes through unchanged", () => {
    const input = "would reformat src/app.py\n";
    expect(blackCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not black output\nat all\nnothing useful here\n".repeat(20);
    expect(blackCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k files)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`would reformat src/file${i}.py`);
    }
    lines.push("Oh no! 💥 💔 💥");
    lines.push("9999 files would be reformatted.");
    const input = lines.join("\n");
    const t0 = performance.now();
    blackCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
