// Tests for the mvn (Apache Maven) compressor.
//
// Covers:
//   1. matches mvn / mvn install / mvn clean install / mvn test
//   2. does NOT match piped/compound or non-mvn commands
//   3. compresses a failing multi-module reactor build by >= 50%
//   4. keeps [ERROR] lines (compiler errors, build errors)
//   5. keeps javac diagnostics (file.java:[LINE,COL] msg)
//   6. keeps test results (Tests run: X, Failures: Y...) + failure details
//   7. keeps BUILD FAILURE / BUILD SUCCESS + Reactor Summary
//   8. drops [INFO] chatter, download noise, plugin banners, build-order list
//   9. tiny input passes through
//  10. garbage input passes through
//  11. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { mvnCompressor } from "../src/compressors/mvn.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("mvn compressor", () => {
  test("matches mvn variants", () => {
    expect(mvnCompressor.matches("bash", { command: "mvn" })).toBe(true);
    expect(mvnCompressor.matches("bash", { command: "mvn install" })).toBe(
      true,
    );
    expect(mvnCompressor.matches("bash", { command: "mvn clean install" })).toBe(
      true,
    );
    expect(mvnCompressor.matches("bash", { command: "mvn test" })).toBe(true);
    expect(mvnCompressor.matches("bash", { command: "mvn package" })).toBe(
      true,
    );
  });

  test("does NOT match piped/compound commands", () => {
    expect(mvnCompressor.matches("bash", { command: "mvn | grep ERROR" })).toBe(
      false,
    );
    expect(mvnCompressor.matches("bash", { command: "mvn && echo ok" })).toBe(
      false,
    );
  });

  test("does NOT match non-mvn commands", () => {
    expect(mvnCompressor.matches("bash", { command: "mvnd install" })).toBe(
      false,
    );
    expect(mvnCompressor.matches("bash", { command: "mvnvm use 3.9" })).toBe(
      false,
    );
    expect(mvnCompressor.matches("bash", { command: "gradle build" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(mvnCompressor.matches("read", { command: "mvn" })).toBe(false);
  });

  test("compresses a failing multi-module build by >= 50%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mvn/build-fail.input.txt", import.meta.url),
    ).text();
    const out = mvnCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.5); // at least 50% reduction
  });

  test("keeps [ERROR] lines (compiler errors + build errors)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mvn/build-fail.input.txt", import.meta.url),
    ).text();
    const out = mvnCompressor.compress(input, CTX);
    // Compiler error diagnostics
    expect(out).toContain(
      "[ERROR] /home/user/project/core/src/main/java/com/example/core/Parser.java:[14,8] cannot find symbol",
    );
    expect(out).toContain(
      "[ERROR] /home/user/project/core/src/main/java/com/example/core/Parser.java:[28,28] incompatible types: int cannot be converted to String",
    );
    // Build error summary
    expect(out).toContain(
      "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin",
    );
  });

  test("keeps test results + failure details", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mvn/build-fail.input.txt", import.meta.url),
    ).text();
    const out = mvnCompressor.compress(input, CTX);
    // Per-class test summary
    expect(out).toContain("Tests run: 6, Failures: 2, Errors: 0, Skipped: 0");
    // Per-test failure detail
    expect(out).toContain("ControllerTest.testGetUser:42 expected:<200> but was:<404>");
    expect(out).toContain("ControllerTest.testCreateUser:78 expected not null");
    // Aggregate results
    expect(out).toContain("[INFO] Results:");
  });

  test("keeps BUILD FAILURE + Reactor Summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mvn/build-fail.input.txt", import.meta.url),
    ).text();
    const out = mvnCompressor.compress(input, CTX);
    expect(out).toContain("[INFO] BUILD FAILURE");
    expect(out).toContain("Reactor Summary for parent 1.0.0-SNAPSHOT");
    // Reactor summary module results
    expect(out).toContain("core ........................................... FAILURE");
    expect(out).toContain("api ............................................ SUCCESS");
    expect(out).toContain("Total time:");
  });

  test("drops [INFO] chatter, download noise, plugin banners, build-order", async () => {
    const input = await Bun.file(
      new URL("./fixtures/mvn/build-fail.input.txt", import.meta.url),
    ).text();
    const out = mvnCompressor.compress(input, CTX);
    // Download noise dropped
    expect(out).not.toContain("Downloading from central");
    expect(out).not.toContain("Downloaded from central");
    // Plugin execution banners dropped (the `[INFO] --- plugin ---` form,
    // NOT the `[ERROR] Failed to execute goal ...plugin...` which is kept)
    expect(out).not.toContain("[INFO] --- maven-compiler-plugin");
    expect(out).not.toContain("[INFO] --- maven-resources-plugin");
    // Building <module> banners dropped
    expect(out).not.toContain("[INFO] Building core 1.0.0-SNAPSHOT");
    // Build order dropped
    expect(out).not.toContain("Reactor Build Order:");
    // Generic INFO chatter dropped
    expect(out).not.toContain("Compiling 24 source files");
    expect(out).not.toContain("Copying 3 resources");
  });

  test("keeps BUILD SUCCESS on a clean single-module build", () => {
    const lines: string[] = [];
    lines.push("[INFO] Scanning for projects...");
    lines.push(
      "[INFO] ----------------< com.example:myapp >----------------",
    );
    lines.push("[INFO] Building myapp 1.0.0-SNAPSHOT");
    lines.push("[INFO] --------------------------------[ jar ]---------------------------------");
    for (let i = 0; i < 15; i++) {
      lines.push(
        `[INFO] --- plugin-${i}:1.0:goal (default) @ myapp ---`,
      );
      lines.push(`[INFO] plugin step ${i} running`);
    }
    lines.push("Downloading from central: https://repo.maven.apache.org/foo.pom");
    lines.push("Downloaded from central: https://repo.maven.apache.org/foo.pom");
    lines.push("[INFO] BUILD SUCCESS");
    lines.push("[INFO] Total time:  03.421 s");
    const input = lines.join("\n");
    const out = mvnCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("[INFO] BUILD SUCCESS");
    expect(out).toContain("Total time:");
    // Chatter dropped
    expect(out).not.toContain("plugin step");
    expect(out).not.toContain("Downloading from central");
  });

  test("keeps Caused by: exception chains", () => {
    const lines: string[] = [];
    lines.push("[ERROR] Failed to execute goal on project core: something broke");
    lines.push("Caused by: org.apache.maven.plugin.MojoExecutionException");
    lines.push("    at org.apache.maven.plugin.DefaultBuildPluginManager.execute(DefaultBuildPluginManager.java:137)");
    lines.push("[INFO] BUILD FAILURE");
    const input = lines.join("\n");
    // Pad to exceed the 200-char threshold.
    const padded = input + "\n".padEnd(220, " ");
    const out = mvnCompressor.compress(padded, CTX);
    expect(out).toContain("Caused by: org.apache.maven.plugin.MojoExecutionException");
  });

  test("tiny input passes through unchanged", () => {
    const input = "[INFO] BUILD SUCCESS";
    expect(mvnCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not maven output\nat all\nnothing useful here\n".repeat(20);
    expect(mvnCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k INFO lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`[INFO] plugin step ${i} running`);
    }
    lines.push("[ERROR] something failed");
    lines.push("[INFO] BUILD FAILURE");
    const input = lines.join("\n");
    const t0 = performance.now();
    mvnCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
