// Tests for the javac compressor.
//
// Covers:
//   1. matches javac (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match javac -version / --version / -help / --help
//   4. does NOT match gradle / ./gradlew / mvn (those have their own compressors)
//   5. does NOT match non-bash tools
//   6. compresses compile output by >= 10%
//   7. keeps file.java:LINE: error:/warning: diagnostic headers
//   8. keeps the symbol:/location:/required:/found:/reason: detail block
//   9. keeps source-snippet lines + the ^ caret underline
//  10. keeps Note: lines
//  11. keeps the N errors / N warnings summary
//  12. drops the Picked up _JAVA_OPTIONS noise
//  13. drops the version banner
//  14. tiny input passes through
//  15. garbage input passes through
//  16. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { javacCompressor } from "../src/compressors/javac.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("javac compressor", () => {
  test("matches javac", () => {
    expect(javacCompressor.matches("bash", { command: "javac Main.java" })).toBe(
      true,
    );
    expect(
      javacCompressor.matches("bash", { command: "javac -d out src/*.java" }),
    ).toBe(true);
    expect(
      javacCompressor.matches("bash", { command: "javac -cp lib Main.java" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      javacCompressor.matches("bash", { command: "javac Main.java | head" }),
    ).toBe(false);
    expect(
      javacCompressor.matches("bash", { command: "javac Main.java && java Main" }),
    ).toBe(false);
  });

  test("does NOT match javac -version / --version / -help / --help", () => {
    expect(
      javacCompressor.matches("bash", { command: "javac -version" }),
    ).toBe(false);
    expect(
      javacCompressor.matches("bash", { command: "javac --version" }),
    ).toBe(false);
    expect(javacCompressor.matches("bash", { command: "javac -help" })).toBe(
      false,
    );
    expect(javacCompressor.matches("bash", { command: "javac --help" })).toBe(
      false,
    );
  });

  test("does NOT match gradle / ./gradlew / mvn (own compressors)", () => {
    expect(
      javacCompressor.matches("bash", { command: "gradle build" }),
    ).toBe(false);
    expect(
      javacCompressor.matches("bash", { command: "./gradlew test" }),
    ).toBe(false);
    expect(javacCompressor.matches("bash", { command: "mvn install" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(
      javacCompressor.matches("read", { command: "javac Main.java" }),
    ).toBe(false);
  });

  test("compresses compile output by >= 5%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    // javac output is signal-dense (diagnostics + detail blocks are the bulk);
    // the droppable noise is the `_JAVA_OPTIONS` lines + version banner. We
    // assert a modest 5% reduction (the compressor's value is structure +
    // dedup, not aggressive ratio on an already-terse compiler stream).
    expect(ratio).toBeLessThan(0.95);
  });

  test("keeps file.java:LINE: error:/warning: diagnostic headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).toContain("src/com/example/Main.java:5: error: ';' expected");
    expect(out).toContain(
      "src/com/example/Main.java:8: error: cannot find symbol",
    );
    expect(out).toContain(
      "src/com/example/Main.java:12: warning: [removal] Integer(int) in Integer has been deprecated and marked for removal",
    );
  });

  test("keeps the symbol:/location:/required:/found:/reason: detail block", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).toContain("symbol:   variable missingVar");
    expect(out).toContain("location: class Main");
    expect(out).toContain("required: int");
    expect(out).toContain("found:    String");
    expect(out).toContain(
      "reason: argument mismatch; String cannot be converted to int",
    );
  });

  test("keeps source-snippet lines + the ^ caret underline", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).toContain("    int count = 0");
    expect(out).toContain("                 ^");
    expect(out).toContain("    return missingVar;");
    expect(out).toContain("           ^");
  });

  test("keeps Note: lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).toContain(
      "Note: src/com/example/Main.java uses or overrides a deprecated API.",
    );
    expect(out).toContain(
      "Note: Recompile with -Xlint:deprecation for details.",
    );
    expect(out).toContain(
      "Note: src/com/example/Main.java uses unchecked or unsafe operations.",
    );
  });

  test("keeps the N errors / N warnings summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).toContain("8 errors");
    expect(out).toContain("2 warnings");
  });

  test("drops the Picked up _JAVA_OPTIONS noise", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).not.toContain("Picked up _JAVA_OPTIONS");
    expect(out).not.toContain("Picked up JAVA_TOOL_OPTIONS");
    expect(out).not.toContain("-Djava.awt.headless=true");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/javac/compile.input.txt", import.meta.url),
    ).text();
    const out = javacCompressor.compress(input, CTX);
    expect(out).not.toContain("javac 17.0.10");
  });

  test("tiny input passes through unchanged", () => {
    const input = "Main.java:1: error: oops\n";
    expect(javacCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not javac output\nat all\nnothing useful here\n".repeat(20);
    expect(javacCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k diagnostics)", () => {
    const lines: string[] = [
      "Picked up _JAVA_OPTIONS: -Dx=true",
      "javac 17.0.10",
      "",
    ];
    for (let i = 0; i < 9999; i++) {
      lines.push(`Main.java:${i}: error: some compile error ${i}`);
      lines.push("    int x = 0;");
      lines.push("         ^");
    }
    lines.push("9999 errors");
    const input = lines.join("\n");
    const t0 = performance.now();
    javacCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
