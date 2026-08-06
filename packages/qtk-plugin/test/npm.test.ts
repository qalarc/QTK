// Tests for the npm/pnpm/yarn install compressor.
//
// Covers:
//   1. matches the right commands (npm/pnpm/yarn install variants)
//   2. does NOT match piped/compound commands or unrelated commands
//   3. compresses a typical npm install by a healthy margin
//   4. keeps the summary line, deprecations, errors, audit
//   5. drops progress/tree noise
//   6. tiny input passes through unchanged
//   7. garbage input passes through unchanged
//   8. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { npmCompressor } from "../src/compressors/npm.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("npm compressor", () => {
  test("matches npm install variants", () => {
    expect(npmCompressor.matches("bash", { command: "npm install" })).toBe(
      true,
    );
    expect(npmCompressor.matches("bash", { command: "npm i" })).toBe(true);
    expect(npmCompressor.matches("bash", { command: "npm ci" })).toBe(true);
    expect(
      npmCompressor.matches("bash", { command: "npm install --save-dev" }),
    ).toBe(true);
  });

  test("matches pnpm and yarn install", () => {
    expect(npmCompressor.matches("bash", { command: "pnpm install" })).toBe(
      true,
    );
    expect(npmCompressor.matches("bash", { command: "pnpm i" })).toBe(true);
    expect(npmCompressor.matches("bash", { command: "pnpm add foo" })).toBe(
      true,
    );
    expect(npmCompressor.matches("bash", { command: "yarn install" })).toBe(
      true,
    );
    expect(npmCompressor.matches("bash", { command: "yarn add foo" })).toBe(
      true,
    );
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      npmCompressor.matches("bash", { command: "npm install | grep foo" }),
    ).toBe(false);
    expect(
      npmCompressor.matches("bash", { command: "npm install && echo done" }),
    ).toBe(false);
  });

  test("does NOT match unrelated npm commands", () => {
    expect(npmCompressor.matches("bash", { command: "npm run build" })).toBe(
      false,
    );
    expect(npmCompressor.matches("bash", { command: "npm test" })).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(npmCompressor.matches("read", { command: "npm install" })).toBe(
      false,
    );
  });

  test("compresses a typical npm install by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/npm/install.input.txt", import.meta.url),
    ).text();
    expect(npmCompressor.matches("bash", { command: "npm install" })).toBe(
      true,
    );
    const out = npmCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
    // Summary line preserved
    expect(out).toContain("added 412 packages");
    // Deprecation warnings preserved
    expect(out).toContain("deprecated");
    expect(out).toContain("request@2.88.2");
    // Errors preserved
    expect(out).toContain("npm ERR!");
    expect(out).toContain("ERESOLVE");
    // Audit info preserved
    expect(out).toContain("vulnerabilities");
  });

  test("drops progress/tree noise but keeps signal", () => {
    const tree = [
      "├── @babel/core@7.0.0",
      "├── @babel/runtime@7.0.0",
      "├── @types/node@20.0.0",
      "├── typescript@5.4.0",
      "├── esbuild@0.21.0",
      "├── react@18.3.0",
      "├── react-dom@18.3.0",
      "└── lodash@4.17.21",
    ].join("\n");
    const input = [
      "npm WARN deprecated request@2.88.2: request has been deprecated",
      tree,
      "",
      "added 50 packages in 3s",
    ].join("\n");
    const out = npmCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("added 50 packages");
    expect(out).toContain("deprecated");
    // Tree branches should be dropped
    expect(out).not.toContain("@babel/core");
  });

  test("pnpm 'Done in' summary is preserved", () => {
    const progress: string[] = [];
    for (let i = 0; i < 20; i++) {
      progress.push(`Progress: resolved ${i * 50}, reused ${i * 45}`);
    }
    const input = [
      ...progress,
      "",
      "dependencies:",
      "  esbuild 0.21.0",
      "  typescript 5.4.0",
      "  react 18.3.0",
      "",
      "Done in 4.21s.",
    ].join("\n");
    const out = npmCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("Done in 4.21s");
  });

  test("tiny input passes through unchanged", () => {
    const input = "added 1 package";
    expect(npmCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not npm output\nat all\nnothing to see here\n".repeat(20);
    expect(npmCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(`npm WARN deprecated pkg-${i}@1.0.0: this is deprecated`);
    }
    lines.push("added 10000 packages in 99s");
    const input = lines.join("\n");
    const t0 = performance.now();
    npmCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
