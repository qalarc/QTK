// Tests for the gradle / ./gradlew compressor.
//
// Covers:
//   1. matches gradle / ./gradlew variants
//   2. does NOT match piped/compound or non-gradle commands
//   3. compresses a failing multi-module build by >= 50%
//   4. keeps failed task lines (`> Task :...: FAILED`)
//   5. keeps javac diagnostics (`file.java:LINE: error:`)
//   6. keeps test failures + stack traces + test summary
//   7. keeps the `* What went wrong:` block + BUILD FAILED summary
//   8. drops successful task lines, download noise, config chatter
//   9. tiny input passes through
//  10. garbage input passes through
//  11. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { gradleCompressor } from "../src/compressors/gradle.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("gradle compressor", () => {
  test("matches gradle variants", () => {
    expect(gradleCompressor.matches("bash", { command: "gradle" })).toBe(true);
    expect(gradleCompressor.matches("bash", { command: "gradle build" })).toBe(
      true,
    );
    expect(gradleCompressor.matches("bash", { command: "gradle test" })).toBe(
      true,
    );
    expect(gradleCompressor.matches("bash", { command: "./gradlew" })).toBe(
      true,
    );
    expect(
      gradleCompressor.matches("bash", { command: "./gradlew assemble" }),
    ).toBe(true);
    expect(
      gradleCompressor.matches("bash", { command: "gradle clean build" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      gradleCompressor.matches("bash", { command: "gradle | grep FAILED" }),
    ).toBe(false);
    expect(
      gradleCompressor.matches("bash", { command: "gradle && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match non-gradle commands", () => {
    expect(
      gradleCompressor.matches("bash", { command: "gradle-wrapper init" }),
    ).toBe(false);
    expect(gradleCompressor.matches("bash", { command: "mvn install" })).toBe(
      false,
    );
    expect(gradleCompressor.matches("bash", { command: "make build" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(gradleCompressor.matches("read", { command: "gradle" })).toBe(false);
  });

  test("compresses a failing multi-module build by >= 50%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.5); // at least 50% reduction
  });

  test("keeps failed task lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    expect(out).toContain("> Task :app:compileJava FAILED");
    expect(out).toContain("> Task :core:test FAILED");
  });

  test("keeps javac diagnostics", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    expect(out).toContain("Parser.java:14: error: cannot find symbol");
    expect(out).toContain("Parser.java:28: error: incompatible types");
    expect(out).toContain("2 errors");
  });

  test("keeps test failures + stack traces + summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    expect(out).toContain("TokenizerTest > testEmptyInput() FAILED");
    expect(out).toContain("ParserTest > testParseInvalid() FAILED");
    // Stack trace under the failed test is kept
    expect(out).toContain("at com.example.core.TokenizerTest.testEmptyInput");
    // Test summary kept
    expect(out).toContain("4 tests completed, 2 failed");
  });

  test("keeps the What-went-wrong block + BUILD FAILED summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    expect(out).toContain("FAILURE: Build failed with an exception.");
    expect(out).toContain("* What went wrong:");
    expect(out).toContain(
      "Execution failed for task ':app:compileJava'.",
    );
    expect(out).toContain("BUILD FAILED in 12s");
  });

  test("drops successful task lines, download noise, config chatter", async () => {
    const input = await Bun.file(
      new URL("./fixtures/gradle/build-fail.input.txt", import.meta.url),
    ).text();
    const out = gradleCompressor.compress(input, CTX);
    // Successful task lines dropped
    expect(out).not.toContain("> Task :core:compileJava\n");
    expect(out).not.toContain("> Task :web:assemble");
    expect(out).not.toContain("> Task :core:processResources");
    // Download noise dropped
    expect(out).not.toContain("Downloading https://");
    expect(out).not.toContain("Downloaded https://");
    // Config chatter dropped
    expect(out).not.toContain("> Configure project");
    expect(out).not.toContain("Resolving dependencies");
    // Version banner dropped
    expect(out).not.toContain("Using Gradle 8.7");
    // Deprecation banner dropped
    expect(out).not.toContain("The automatic loading");
    // Test pass lines dropped
    expect(out).not.toContain("testSingleToken() PASSED");
    // Try/help blocks dropped
    expect(out).not.toContain("Run with --stacktrace");
    expect(out).not.toContain("gradle.org/help/");
  });

  test("keeps BUILD SUCCESSFUL on a clean build", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`> Task :module-${i}:compileJava`);
    }
    lines.push("BUILD SUCCESSFUL in 8s");
    lines.push("15 actionable tasks: 15 executed");
    const input = lines.join("\n");
    const out = gradleCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("BUILD SUCCESSFUL in 8s");
    // Successful task lines dropped
    expect(out).not.toContain("module-0:compileJava");
  });

  test("tiny input passes through unchanged", () => {
    const input = "BUILD SUCCESSFUL in 1s";
    expect(gradleCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not gradle output\nat all\nnothing useful here\n".repeat(20);
    expect(gradleCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k task lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`> Task :module-${i}:compileJava`);
    }
    lines.push("> Task :app:compileJava FAILED");
    lines.push("BUILD FAILED in 99s");
    const input = lines.join("\n");
    const t0 = performance.now();
    gradleCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
