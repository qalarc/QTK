// Tests for the luacheck compressor.
//
// Covers:
//   1. matches luacheck (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match luacheck --version / --help
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file:line:col: (CODE) message finding lines
//   7. keeps the Total: N errors / M warnings summary
//   8. drops the Checking <file> progress lines
//   9. drops the stat block (Files/Lines/Checks)
//  10. tiny input passes through
//  11. garbage input passes through
//  12. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { luacheckCompressor } from "../src/compressors/luacheck.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("luacheck compressor", () => {
  test("matches luacheck", () => {
    expect(luacheckCompressor.matches("bash", { command: "luacheck ." })).toBe(true);
    expect(luacheckCompressor.matches("bash", { command: "luacheck src/" })).toBe(true);
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck --codes ." }),
    ).toBe(true);
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck *.lua" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck . | grep W111" }),
    ).toBe(false);
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match luacheck --version / --help", () => {
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck --version" }),
    ).toBe(false);
    expect(
      luacheckCompressor.matches("bash", { command: "luacheck --help" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(luacheckCompressor.matches("read", { command: "luacheck ." })).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/luacheck/lint.input.txt", import.meta.url),
    ).text();
    const out = luacheckCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file:line:col: (CODE) message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/luacheck/lint.input.txt", import.meta.url),
    ).text();
    const out = luacheckCompressor.compress(input, CTX);
    expect(out).toContain(
      "src/init.lua:2:1: (W111) setting non-standard global variable 'path'",
    );
    expect(out).toContain(
      "src/init.lua:5:10: (W112) accessing undefined variable 'undefined_fn'",
    );
    expect(out).toContain(
      "src/handlers.lua:20:5: (E011) expected statement near '='",
    );
    expect(out).toContain(
      "src/utils.lua:8:3: (W212) unused argument 'self'",
    );
  });

  test("keeps the Total: N errors / M warnings summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/luacheck/lint.input.txt", import.meta.url),
    ).text();
    const out = luacheckCompressor.compress(input, CTX);
    expect(out).toContain("Total: 1 error / 7 warnings in 3 files");
  });

  test("drops the Checking <file> progress lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/luacheck/lint.input.txt", import.meta.url),
    ).text();
    const out = luacheckCompressor.compress(input, CTX);
    expect(out).not.toContain("Checking src/init.lua");
    expect(out).not.toContain("Checking src/utils.lua");
  });

  test("drops the stat block (Files/Lines/Checks)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/luacheck/lint.input.txt", import.meta.url),
    ).text();
    const out = luacheckCompressor.compress(input, CTX);
    expect(out).not.toContain("Files: 3");
    expect(out).not.toContain("Lines: 142");
    expect(out).not.toContain("Checks: 8");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/init.lua:1:1: (W001) oops\n";
    expect(luacheckCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not luacheck output\nat all\nnothing useful here\n".repeat(20);
    expect(luacheckCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["Checking src/huge.lua    9999 warnings"];
    for (let i = 0; i < 9999; i++) {
      lines.push(`src/file${i}.lua:${i}:1: (W111) some luacheck finding ${i}`);
    }
    lines.push("Total: 0 errors / 9999 warnings in 1 file");
    lines.push("Files: 1");
    lines.push("Lines: 99999");
    const input = lines.join("\n");
    const t0 = performance.now();
    luacheckCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
