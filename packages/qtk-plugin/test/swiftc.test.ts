// Tests for the swiftc compressor.
//
// Covers:
//   1. matches swiftc / swift build (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match swift --version / swift package / swift run / swift test
//   4. does NOT match non-bash tools
//   5. compresses compile output by >= 10%
//   6. keeps file.swift:LINE:COL: error:/warning:/note: diagnostic headers
//   7. keeps source-snippet lines + the ^~~ caret underline
//   8. keeps the <Unknown>:0: aggregate marker + error: fatalError driver summary
//   9. drops the version banner
//  10. drops progress chatter (Compiling/Linking/Building)
//  11. drops toolchain-discovery noise (Finding/Found/Considering)
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { swiftcCompressor } from "../src/compressors/swiftc.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("swiftc compressor", () => {
  test("matches swiftc / swift build", () => {
    expect(swiftcCompressor.matches("bash", { command: "swiftc main.swift" }))
      .toBe(true);
    expect(
      swiftcCompressor.matches("bash", {
        command: "swiftc -emit-executable main.swift",
      }),
    ).toBe(true);
    expect(swiftcCompressor.matches("bash", { command: "swift build" })).toBe(
      true,
    );
    expect(
      swiftcCompressor.matches("bash", {
        command: "swift build --configuration release",
      }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      swiftcCompressor.matches("bash", { command: "swiftc main.swift | head" }),
    ).toBe(false);
    expect(
      swiftcCompressor.matches("bash", { command: "swift build && ./app" }),
    ).toBe(false);
  });

  test("does NOT match swift --version / package / run / test", () => {
    expect(
      swiftcCompressor.matches("bash", { command: "swift --version" }),
    ).toBe(false);
    expect(
      swiftcCompressor.matches("bash", { command: "swiftc --version" }),
    ).toBe(false);
    expect(
      swiftcCompressor.matches("bash", { command: "swift package update" }),
    ).toBe(false);
    expect(swiftcCompressor.matches("bash", { command: "swift run" })).toBe(
      false,
    );
    expect(swiftcCompressor.matches("bash", { command: "swift test" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(
      swiftcCompressor.matches("read", { command: "swiftc main.swift" }),
    ).toBe(false);
  });

  test("compresses compile output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.swift:LINE:COL: error:/warning:/note: diagnostic headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).toContain(
      "main.swift:5:7: warning: variable 'count' was never used; consider replacing with '_' or removing it",
    );
    expect(out).toContain(
      "main.swift:10:14: error: use of unresolved identifier 'missingVar'",
    );
    expect(out).toContain("main.swift:3:1: note: 'process' declared here");
  });

  test("keeps source-snippet lines + the ^~~ caret underline", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).toContain("let count = 0");
    expect(out).toContain("    ^~~~~");
    expect(out).toContain("return missingVar");
    expect(out).toContain("       ^~~~~~~~~~");
  });

  test("keeps <Unknown>:0: aggregate marker + error: fatalError driver summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).toContain("<Unknown>:0: error: build had 1 command failure");
    expect(out).toContain("error: fatalError");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).not.toContain("Swift version 5.10.1");
    expect(out).not.toContain("swift-driver version");
    expect(out).not.toContain("Target:");
  });

  test("drops progress chatter (Compiling/Linking/Building)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).not.toContain("Building main.swift");
    expect(out).not.toContain("Compiling main.swift");
    expect(out).not.toContain("Linking main");
  });

  test("drops toolchain-discovery noise (Finding/Found/Considering)", async () => {
    const input = await Bun.file(
      new URL("./fixtures/swiftc/compile.input.txt", import.meta.url),
    ).text();
    const out = swiftcCompressor.compress(input, CTX);
    expect(out).not.toContain("Finding /usr/lib/swift/linux");
    expect(out).not.toContain("Found /usr/lib/swift/linux");
    expect(out).not.toContain("Considering /usr/lib/swift/linux");
  });

  test("tiny input passes through unchanged", () => {
    const input = "main.swift:1:1: error: oops\n";
    expect(swiftcCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not swiftc output\nat all\nnothing useful here\n".repeat(20);
    expect(swiftcCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k diagnostics)", () => {
    const lines: string[] = [
      "Swift version 5.10.1",
      "Building main.swift",
      "",
    ];
    for (let i = 0; i < 9999; i++) {
      lines.push(`main.swift:${i}:1: error: some compile error ${i}`);
      lines.push("let x = 0");
      lines.push("    ^");
    }
    lines.push("<Unknown>:0: error: build had 1 command failure");
    lines.push("error: fatalError");
    const input = lines.join("\n");
    const t0 = performance.now();
    swiftcCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
