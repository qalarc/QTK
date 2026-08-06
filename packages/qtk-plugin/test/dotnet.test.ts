// Tests for the dotnet build / dotnet test compressor.
//
// Covers:
//   1. matches dotnet build / test / publish / msbuild
//   2. does NOT match piped/compound or non-dotnet commands
//   3. compresses a failing build + test run by >= 40%
//   4. keeps compiler diagnostics (file.cs(L,C): error CSxxxx:)
//   5. keeps warnings + the error/warning count summary
//   6. keeps test failures + Error Message + Stack Trace blocks
//   7. keeps Passed/Failed/Total tests summary + Build verdict
//   8. drops restore noise, link lines, passing tests, banners, timing
//   9. tiny input passes through
//  10. garbage input passes through
//  11. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { dotnetCompressor } from "../src/compressors/dotnet.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("dotnet compressor", () => {
  test("matches dotnet build/test/publish/msbuild", () => {
    expect(dotnetCompressor.matches("bash", { command: "dotnet build" })).toBe(
      true,
    );
    expect(dotnetCompressor.matches("bash", { command: "dotnet test" })).toBe(
      true,
    );
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet publish" }),
    ).toBe(true);
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet msbuild" }),
    ).toBe(true);
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet build src/App" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet build | grep error" }),
    ).toBe(false);
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet build && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match non-build dotnet commands", () => {
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet run" }),
    ).toBe(false);
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet-format" }),
    ).toBe(false);
    expect(
      dotnetCompressor.matches("bash", { command: "dotnet restore" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(dotnetCompressor.matches("read", { command: "dotnet build" })).toBe(
      false,
    );
  });

  test("compresses a failing build + test run by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
  });

  test("keeps compiler diagnostics (strips [project] suffix)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    expect(out).toContain(
      "/home/user/project/src/Core/Parser.cs(14,8): error CS0246: The type or namespace name 'Tokenizer' could not be found",
    );
    expect(out).toContain(
      "/home/user/project/src/Core/Parser.cs(28,18): error CS1503: Argument 1: cannot convert from 'int' to 'string'",
    );
    expect(out).toContain(
      "/home/user/project/src/App/Program.cs(10,5): error CS0103: The name 'Initialize' does not exist in the current context",
    );
    // The [project] suffix is stripped
    expect(out).not.toContain("[/home/user/project/src/Core/Core.csproj]");
  });

  test("keeps warnings + error/warning count summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    expect(out).toContain(
      "/home/user/project/src/Core/Lexer.cs(42,7): warning CS0168:",
    );
    expect(out).toContain("3 Error(s)");
    expect(out).toContain("2 Warning(s)");
  });

  test("keeps test failures + Error Message + Stack Trace blocks", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    expect(out).toContain("Failed Tests.ParserTests.TestParseValid");
    expect(out).toContain("Failed Tests.ParserTests.TestParseInvalid");
    expect(out).toContain("Error Message:");
    expect(out).toContain('Expected: "ERROR"');
    expect(out).toContain('But was:  "ERRO"');
    expect(out).toContain("Stack Trace:");
    expect(out).toContain(
      "at Tests.ParserTests.TestParseValid() in /home/user/project/src/Tests/ParserTests.cs:line 88",
    );
  });

  test("keeps Passed/Failed/Total summary + Build verdict", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    expect(out).toContain("Passed: 4");
    expect(out).toContain("Failed: 2");
    expect(out).toContain("Total tests: 6");
    expect(out).toContain("Build FAILED.");
    expect(out).toContain("Build succeeded.");
  });

  test("drops restore noise, link lines, passing tests, banners, timing", async () => {
    const input = await Bun.file(
      new URL("./fixtures/dotnet/build-fail.input.txt", import.meta.url),
    ).text();
    const out = dotnetCompressor.compress(input, CTX);
    // Restore noise dropped
    expect(out).not.toContain("Determining projects to restore");
    expect(out).not.toContain("Restored /home/user/project/src/App/App.csproj");
    // MSBuild banner dropped
    expect(out).not.toContain("MSBuild version 17.9.8");
    // Test preamble dropped
    expect(out).not.toContain("Starting test execution");
    expect(out).not.toContain("Test run for");
    // Passing test lines dropped
    expect(out).not.toContain("Passed Tests.ParserTests.TestEmptyInput");
    expect(out).not.toContain("Passed Tests.LexerTests.TestTokenize");
    // Timing dropped
    expect(out).not.toContain("Time Elapsed");
  });

  test("tiny input passes through unchanged", () => {
    const input = "Build succeeded. 0 Error(s)";
    expect(dotnetCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not dotnet output\nat all\nnothing useful here\n".repeat(20);
    expect(dotnetCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k restore lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`  Restored /home/user/project/src/Proj-${i}/Proj-${i}.csproj (in 1.23 sec).`);
    }
    lines.push("/home/user/project/src/App/Program.cs(1,1): error CS0111: boom");
    lines.push("Build FAILED.");
    const input = lines.join("\n");
    const t0 = performance.now();
    dotnetCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
