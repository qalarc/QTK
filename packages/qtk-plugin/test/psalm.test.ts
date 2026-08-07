// Tests for the psalm compressor.
//
// Covers:
//   1. matches psalm / vendor/bin/psalm (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match psalm --version / --alter / --init / --shepherd
//   4. does NOT match non-bash tools
//   5. compresses analyse output by >= 10%
//   6. keeps SEVERITY: IssueType - file:line:col - message finding lines
//   7. keeps the N errors found summary
//   8. drops the version banner
//   9. drops the progress lines (Scanning/Analyzing)
//  10. drops the --alter hint
//  11. parses JSON output format
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { psalmCompressor } from "../src/compressors/psalm.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("psalm compressor", () => {
  test("matches psalm / vendor/bin/psalm", () => {
    expect(psalmCompressor.matches("bash", { command: "psalm" })).toBe(true);
    expect(psalmCompressor.matches("bash", { command: "psalm src/" })).toBe(true);
    expect(psalmCompressor.matches("bash", { command: "vendor/bin/psalm" })).toBe(true);
    expect(psalmCompressor.matches("bash", { command: "psalm --no-cache" })).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      psalmCompressor.matches("bash", { command: "psalm | grep ERROR" }),
    ).toBe(false);
    expect(
      psalmCompressor.matches("bash", { command: "psalm && echo done" }),
    ).toBe(false);
  });

  test("does NOT match psalm --version / --alter / --init / --shepherd", () => {
    expect(psalmCompressor.matches("bash", { command: "psalm --version" })).toBe(false);
    expect(psalmCompressor.matches("bash", { command: "psalm --alter" })).toBe(false);
    expect(psalmCompressor.matches("bash", { command: "psalm --init" })).toBe(false);
    expect(psalmCompressor.matches("bash", { command: "psalm --shepherd" })).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(psalmCompressor.matches("read", { command: "psalm" })).toBe(false);
  });

  test("compresses analyse output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps SEVERITY: IssueType - file:line:col - message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).toContain(
      "ERROR: UndefinedClass - src/App.php:10:5 - Class App not found",
    );
    expect(out).toContain(
      "ERROR: NullArgument - src/Service/UserService.php:42:23 -",
    );
    expect(out).toContain(
      "INFO: MissingReturnType - src/Handler.php:15 -",
    );
  });

  test("keeps the N errors found summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).toContain("4 errors found");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).not.toContain("Psalm 5.20.0");
  });

  test("drops the progress lines (Scanning/Analyzing)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).not.toContain("Scanning files...");
    expect(out).not.toContain("Analyzing files...");
  });

  test("drops the --alter hint", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/analyse.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).not.toContain("To fix the errors found");
    expect(out).not.toContain("--alter --issues=all");
  });

  test("parses JSON output format", async () => {
    const input = await Bun.file(
      new URL("./fixtures/psalm/json.input.txt", import.meta.url),
    ).text();
    const out = psalmCompressor.compress(input, CTX);
    expect(out).toContain("ERROR: UndefinedClass - src/App.php:10:5 - Class App not found");
    expect(out).toContain(
      "ERROR: NullArgument - src/Service/UserService.php:42:23 -",
    );
    expect(out).toContain("3 errors found");
  });

  test("tiny input passes through unchanged", () => {
    const input = "ERROR: Foo - src/App.php:1:1 - oops\n";
    expect(psalmCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not psalm output\nat all\nnothing useful here\n".repeat(20);
    expect(psalmCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [
      "Target PHP version: 8.1",
      "Scanning files...",
      "Analyzing files...",
      "Psalm 5.20.0@abc123",
    ];
    for (let i = 0; i < 9999; i++) {
      lines.push(`ERROR: Issue${i} - src/file${i}.php:${i}:1 - some psalm finding ${i}`);
    }
    lines.push("9999 errors found");
    lines.push("To fix the errors found, run Psalm with the flag --alter --issues=all");
    const input = lines.join("\n");
    const t0 = performance.now();
    psalmCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
