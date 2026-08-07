// Tests for the shellcheck compressor.
//
// Covers:
//   1. matches shellcheck (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match shellcheck --version
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10% (the URL epilogue is the droppable)
//   6. keeps `In <file> line N:` location headers
//   7. keeps source lines (context)
//   8. keeps `^-- SCxxxx (severity): message.` finding lines
//   9. drops the `For more information:` epilogue + wiki URL list
//  10. tiny input passes through
//  11. garbage input passes through
//  12. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { shellcheckCompressor } from "../src/compressors/shellcheck.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("shellcheck compressor", () => {
  test("matches shellcheck", () => {
    expect(
      shellcheckCompressor.matches("bash", { command: "shellcheck *.sh" }),
    ).toBe(true);
    expect(
      shellcheckCompressor.matches("bash", { command: "shellcheck deploy.sh" }),
    ).toBe(true);
    expect(
      shellcheckCompressor.matches("bash", {
        command: "shellcheck -x scripts/build.sh",
      }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      shellcheckCompressor.matches("bash", {
        command: "shellcheck *.sh | grep SC2086",
      }),
    ).toBe(false);
    expect(
      shellcheckCompressor.matches("bash", {
        command: "shellcheck deploy.sh && echo ok",
      }),
    ).toBe(false);
  });

  test("does NOT match shellcheck --version", () => {
    expect(
      shellcheckCompressor.matches("bash", { command: "shellcheck --version" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      shellcheckCompressor.matches("read", { command: "shellcheck *.sh" }),
    ).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/shellcheck/lint.input.txt", import.meta.url),
    ).text();
    const out = shellcheckCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    // The droppable part is the wiki URL epilogue (~15% of this fixture).
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps In <file> line N: location headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/shellcheck/lint.input.txt", import.meta.url),
    ).text();
    const out = shellcheckCompressor.compress(input, CTX);
    expect(out).toContain("In ./deploy.sh line 3:");
    expect(out).toContain("In ./scripts/build.sh line 5:");
    expect(out).toContain("In ./scripts/cleanup.sh line 3:");
  });

  test("keeps source lines (context)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/shellcheck/lint.input.txt", import.meta.url),
    ).text();
    const out = shellcheckCompressor.compress(input, CTX);
    expect(out).toContain('if [ "$ENV" = "prod" ]; then');
    expect(out).toContain("SERVERS=$(cat servers.txt)");
    expect(out).toContain("for server in $SERVERS; do");
  });

  test("keeps ^-- SCxxxx (severity): message. finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/shellcheck/lint.input.txt", import.meta.url),
    ).text();
    const out = shellcheckCompressor.compress(input, CTX);
    expect(out).toContain(
      "^-- SC2086 (info): Double quote to prevent globbing and word splitting.",
    );
    expect(out).toContain(
      "^-- SC2002 (style): Useless cat. Consider 'cmd < file | ..' or just 'cmd file' instead.",
    );
    expect(out).toContain(
      "^-- SC2006 (style): Use $() instead of legacy backticks.",
    );
    expect(out).toContain(
      "^-- SC2044 (warning): For loops over find output are fragile. Use find -exec or a while read loop.",
    );
  });

  test("drops For more information: epilogue + wiki URL list", async () => {
    const input = await Bun.file(
      new URL("./fixtures/shellcheck/lint.input.txt", import.meta.url),
    ).text();
    const out = shellcheckCompressor.compress(input, CTX);
    expect(out).not.toContain("For more information:");
    expect(out).not.toContain("https://www.shellcheck.net/wiki/SC2086");
    expect(out).not.toContain("https://www.shellcheck.net/wiki/SC2002");
  });

  test("tiny input passes through unchanged", () => {
    const input = "In foo.sh line 1:\necho hi\n^-- SC2086 (info): quote\n";
    expect(shellcheckCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not shellcheck output\nat all\nnothing useful here\n".repeat(20);
    expect(shellcheckCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`In script.sh line ${i}:`);
      lines.push(`echo $VAR-${i}`);
      lines.push(`     ^-- SC2086 (info): Double quote to prevent globbing.`);
    }
    lines.push("For more information:");
    lines.push("  https://www.shellcheck.net/wiki/SC2086 -- Double quote ...");
    const input = lines.join("\n");
    const t0 = performance.now();
    shellcheckCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
