// Tests for the tsc (TypeScript compiler) compressor.
//
// Covers:
//   1. matches tsc / npx tsc / yarn tsc / pnpm tsc / bunx tsc
//   2. does NOT match piped/compound or non-tsc commands
//   3. compresses a typical error run by >= 20% (dedup + grouping)
//   4. drops exact-duplicate adjacent diagnostics
//   5. groups diagnostics by file
//   6. keeps the `Found N errors in M files.` summary
//   7. drops watch-mode noise + version banner
//   8. tiny input passes through
//   9. garbage input passes through
//  10. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { tscCompressor } from "../src/compressors/tsc.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("tsc compressor", () => {
  test("matches tsc variants", () => {
    expect(tscCompressor.matches("bash", { command: "tsc" })).toBe(true);
    expect(tscCompressor.matches("bash", { command: "tsc --noEmit" })).toBe(
      true,
    );
    expect(tscCompressor.matches("bash", { command: "tsc -b" })).toBe(true);
    expect(tscCompressor.matches("bash", { command: "npx tsc" })).toBe(true);
    expect(tscCompressor.matches("bash", { command: "yarn tsc" })).toBe(true);
    expect(tscCompressor.matches("bash", { command: "pnpm tsc" })).toBe(true);
    expect(tscCompressor.matches("bash", { command: "bunx tsc" })).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(tscCompressor.matches("bash", { command: "tsc | grep error" })).toBe(
      false,
    );
    expect(tscCompressor.matches("bash", { command: "tsc && echo ok" })).toBe(
      false,
    );
  });

  test("does NOT match non-tsc commands", () => {
    expect(tscCompressor.matches("bash", { command: "tscc foo" })).toBe(false);
    expect(
      tscCompressor.matches("bash", { command: "node tsc.umd.js" }),
    ).toBe(false);
    expect(tscCompressor.matches("bash", { command: "eslint src" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(tscCompressor.matches("read", { command: "tsc" })).toBe(false);
  });

  test("compresses a typical error run by >= 20%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/tsc/errors.input.txt", import.meta.url),
    ).text();
    const out = tscCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.8); // at least 20% reduction (dedup + grouping)
    // Summary preserved
    expect(out).toContain("Found 24 errors in 6 files");
    // Diagnostics preserved (one of each distinct error)
    expect(out).toContain("TS2322");
    expect(out).toContain("TS2304");
    expect(out).toContain("Cannot find name 'foo'");
    // Grouped by file
    expect(out).toContain("src/index.ts:");
    expect(out).toContain("src/codegen.ts:");
  });

  test("drops exact-duplicate adjacent diagnostics", () => {
    const lines: string[] = [];
    // 20 identical lines (incremental-build echo)
    for (let i = 0; i < 20; i++) {
      lines.push("src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    }
    lines.push("Found 1 error in 1 file.");
    const input = lines.join("\n");
    const out = tscCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    // The diagnostic appears exactly once (deduped)
    const count = (out.match(/TS2322/g) || []).length;
    expect(count).toBe(1);
    // Duplicate-drop count reported
    expect(out).toContain("19 duplicate lines dropped");
  });

  test("keeps distinct diagnostics even when adjacent", () => {
    const input = [
      "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      "src/a.ts(2,2): error TS2304: Cannot find name 'bar'.",
      "src/a.ts(3,3): error TS2339: Property 'x' does not exist on type 'Y'.",
      "Found 3 errors in 1 file.",
    ].join("\n");
    const out = tscCompressor.compress(input, CTX);
    expect(out).toContain("Cannot find name 'foo'");
    expect(out).toContain("Cannot find name 'bar'");
    expect(out).toContain("Property 'x'");
    expect(out).toContain("Found 3 errors in 1 file");
  });

  test("drops watch-mode noise + version banner", () => {
    const input = [
      "10:01:23 - Starting compilation in watch mode...",
      "10:01:24 - File change detected. Starting incremental compilation...",
      "Version 5.4.5",
      "src/foo.ts(1,1): error TS2304: Cannot find name 'foo'.",
      "Found 1 error in 1 file.",
      "10:01:25 - Compilation complete. Watching for file changes.",
    ].join("\n");
    const out = tscCompressor.compress(input, CTX);
    expect(out).toContain("Cannot find name 'foo'");
    expect(out).not.toContain("Starting compilation");
    expect(out).not.toContain("File change detected");
    expect(out).not.toContain("Version 5.4.5");
  });

  test("tiny input passes through unchanged", () => {
    const input = "src/foo.ts(1,1): error TS9999: boom";
    expect(tscCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not tsc output\nat all\nnothing useful here\n".repeat(20);
    expect(tscCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k diagnostics)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(
        `src/file-${i}.ts(${i},1): error TS2304: Cannot find name 'var${i}'.`,
      );
    }
    lines.push("Found 10000 errors in 10000 files.");
    const input = lines.join("\n");
    const t0 = performance.now();
    tscCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
