// Tests for the phpstan compressor.
//
// Covers:
//   1. matches phpstan analyse / vendor/bin/phpstan (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match phpstan --version / list / help / generate-baseline
//   4. does NOT match non-bash tools
//   5. compresses analyse output by >= 10%
//   6. keeps the N) file:line: message finding lines
//   7. keeps the [ERROR] Found N errors summary
//   8. drops the version banner
//   9. drops the progress bar
//  10. parses JSON output format
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { phpstanCompressor } from "../src/compressors/phpstan.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("phpstan compressor", () => {
  test("matches phpstan analyse / vendor/bin/phpstan", () => {
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan analyse src/" }),
    ).toBe(true);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan analyse" }),
    ).toBe(true);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan analyse --level=5 src/" }),
    ).toBe(true);
    expect(
      phpstanCompressor.matches("bash", { command: "vendor/bin/phpstan analyse" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan analyse | grep error" }),
    ).toBe(false);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan analyse && echo done" }),
    ).toBe(false);
  });

  test("does NOT match phpstan --version / list / help / generate-baseline", () => {
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan --version" }),
    ).toBe(false);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan list" }),
    ).toBe(false);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan help" }),
    ).toBe(false);
    expect(
      phpstanCompressor.matches("bash", { command: "phpstan generate-baseline" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      phpstanCompressor.matches("read", { command: "phpstan analyse" }),
    ).toBe(false);
  });

  test("compresses analyse output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/analyse.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps the N) file:line: message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/analyse.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out).toContain("1) src/File1.php:5: Some phpstan finding number 1");
    expect(out).toContain("2) src/File2.php:10: Some phpstan finding number 2");
    expect(out).toContain("10) src/File10.php:50: Some phpstan finding number 10");
    expect(out).toContain("20) src/File20.php:100: Some phpstan finding number 20");
  });

  test("keeps the [ERROR] Found N errors summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/analyse.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out).toContain("[ERROR] Found 20 errors");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/analyse.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out).not.toContain("Note: Using version");
  });

  test("drops the progress bar", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/analyse.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out).not.toMatch(/\d+\/\d+\s+\[/);
  });

  test("parses JSON output format", async () => {
    const input = await Bun.file(
      new URL("./fixtures/phpstan/json.input.txt", import.meta.url),
    ).text();
    const out = phpstanCompressor.compress(input, CTX);
    expect(out).toContain("src/App.php:10: Class App not found.");
    expect(out).toContain("src/App.php:15: Cannot access property $name on App|null.");
    expect(out).toContain(
      "src/Service/UserService.php:42: Method App\\Service\\UserService::find() should return App\\User but returns App\\Model\\User|null.",
    );
    expect(out).toContain("[ERROR] Found 4 errors");
  });

  test("tiny input passes through unchanged", () => {
    const input = "1) src/App.php:1: oops\n";
    expect(phpstanCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not phpstan output\nat all\nnothing useful here\n".repeat(20);
    expect(phpstanCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["Note: Using version 1.10.67", " 1/1 [▓▓▓] 100%"];
    for (let i = 0; i < 9999; i++) {
      lines.push(`${i + 1}) src/file${i}.php:${i}: some phpstan finding ${i}`);
    }
    lines.push(" ✘  [ERROR] Found 9999 errors");
    const input = lines.join("\n");
    const t0 = performance.now();
    phpstanCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
