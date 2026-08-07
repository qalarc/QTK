// Tests for the rubocop compressor.
//
// Covers:
//   1. matches rubocop / bundle exec rubocop (with/without args/paths)
//   2. does NOT match piped/compound commands
//   3. does NOT match rubocop --version / -a / --auto-correct / --show-cops
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps file.rb:LINE:COL: SEV: RuleName: message finding lines
//   7. keeps the N files inspected, M offenses detected summary
//   8. drops the Inspecting N files progress line
//   9. drops the dotted progress bar
//  10. drops watch-mode chatter
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { rubocopCompressor } from "../src/compressors/rubocop.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("rubocop compressor", () => {
  test("matches rubocop / bundle exec rubocop", () => {
    expect(rubocopCompressor.matches("bash", { command: "rubocop" })).toBe(
      true,
    );
    expect(rubocopCompressor.matches("bash", { command: "rubocop app/" })).toBe(
      true,
    );
    expect(
      rubocopCompressor.matches("bash", { command: "bundle exec rubocop" }),
    ).toBe(true);
    expect(
      rubocopCompressor.matches("bash", {
        command: "rubocop --only Style/StringLiterals",
      }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      rubocopCompressor.matches("bash", {
        command: "rubocop | grep Style",
      }),
    ).toBe(false);
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop && echo done" }),
    ).toBe(false);
  });

  test("does NOT match rubocop --version / -a / --auto-correct / --show-cops", () => {
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop --version" }),
    ).toBe(false);
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop -a" }),
    ).toBe(false);
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop -A" }),
    ).toBe(false);
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop --auto-correct" }),
    ).toBe(false);
    expect(
      rubocopCompressor.matches("bash", { command: "rubocop --show-cops" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      rubocopCompressor.matches("read", { command: "rubocop" }),
    ).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rubocop/lint.input.txt", import.meta.url),
    ).text();
    const out = rubocopCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.rb:LINE:COL: SEV: RuleName: message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rubocop/lint.input.txt", import.meta.url),
    ).text();
    const out = rubocopCompressor.compress(input, CTX);
    expect(out).toContain(
      "app/models/user.rb:10:5: C: Style/StringLiterals: Prefer single-quoted strings when you don't need string interpolation or special symbols.",
    );
    expect(out).toContain(
      "app/controllers/users_controller.rb:25:5: R: Rails/Blank: Use blank? instead of nil? || empty?.",
    );
    expect(out).toContain(
      "lib/tasks/db.rake:12:5: E: Lint/Syntax: unexpected token tCOMMA",
    );
    expect(out).toContain(
      "config/initializers/secret.rb:5:1: F: Lint/UselessAssignment: Useless assignment to variable - secret_key.",
    );
  });

  test("keeps the N files inspected, M offenses detected summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rubocop/lint.input.txt", import.meta.url),
    ).text();
    const out = rubocopCompressor.compress(input, CTX);
    expect(out).toContain("247 files inspected, 47 offenses detected");
  });

  test("drops the Inspecting N files progress line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rubocop/lint.input.txt", import.meta.url),
    ).text();
    const out = rubocopCompressor.compress(input, CTX);
    expect(out).not.toContain("Inspecting 247 files");
  });

  test("drops the dotted progress bar", async () => {
    const input = await Bun.file(
      new URL("./fixtures/rubocop/lint.input.txt", import.meta.url),
    ).text();
    const out = rubocopCompressor.compress(input, CTX);
    // No line should be only dots/stars.
    expect(out).not.toMatch(/\n[.*]+\n/);
  });

  test("drops watch-mode chatter", () => {
    const lines: string[] = [
      "RuboCop is running in watch mode",
      "For more information: https://docs.rubocop.org",
    ];
    for (let i = 0; i < 30; i++) {
      lines.push(`app/file${i}.rb:1:1: C: Style/Foo: some message ${i}`);
    }
    lines.push("30 files inspected, 30 offenses detected");
    const input = lines.join("\n");
    const out = rubocopCompressor.compress(input, CTX);
    expect(out).not.toContain("watch mode");
    expect(out).not.toContain("For more information");
  });

  test("tiny input passes through unchanged", () => {
    const input = "app/models/user.rb:10:5: C: Style/Foo: oops\n";
    expect(rubocopCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not rubocop output\nat all\nnothing useful here\n".repeat(20);
    expect(rubocopCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["Inspecting 10000 files"];
    // dotted progress bar
    lines.push(".".repeat(100));
    for (let i = 0; i < 9999; i++) {
      lines.push(
        `app/file${i}.rb:${i}:1: C: Style/Foo: some rubocop finding ${i}`,
      );
    }
    lines.push("10000 files inspected, 9999 offenses detected");
    const input = lines.join("\n");
    const t0 = performance.now();
    rubocopCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
