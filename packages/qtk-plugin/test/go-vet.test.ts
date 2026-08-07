// Tests for the go-vet compressor.
//
// Covers:
//   1. matches go vet / go tool vet (with/without args/flags)
//   2. does NOT match go test / go build (handled by the go compressor)
//   3. does NOT match piped/compound commands
//   4. does NOT match go vet -h / --help
//   5. does NOT match non-bash tools
//   6. compresses vet output by >= 10%
//   7. keeps file.go:LINE:COL: checker: message finding lines
//   8. keeps the exit status N line
//   9. drops the version banner
//  10. drops the # package/path section headers
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { goVetCompressor } from "../src/compressors/go-vet.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("go-vet compressor", () => {
  test("matches go vet / go tool vet", () => {
    expect(goVetCompressor.matches("bash", { command: "go vet ./..." })).toBe(
      true,
    );
    expect(goVetCompressor.matches("bash", { command: "go vet ." })).toBe(true);
    expect(
      goVetCompressor.matches("bash", { command: "go vet -composites ./..." }),
    ).toBe(true);
    expect(
      goVetCompressor.matches("bash", { command: "go tool vet ./pkg" }),
    ).toBe(true);
  });

  test("does NOT match go test / go build (handled by go compressor)", () => {
    expect(goVetCompressor.matches("bash", { command: "go test ./..." })).toBe(
      false,
    );
    expect(goVetCompressor.matches("bash", { command: "go build" })).toBe(
      false,
    );
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      goVetCompressor.matches("bash", { command: "go vet ./... | grep printf" }),
    ).toBe(false);
    expect(
      goVetCompressor.matches("bash", { command: "go vet . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match go vet -h / --help", () => {
    expect(goVetCompressor.matches("bash", { command: "go vet -h" })).toBe(
      false,
    );
    expect(goVetCompressor.matches("bash", { command: "go vet --help" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(goVetCompressor.matches("read", { command: "go vet ./..." })).toBe(
      false,
    );
  });

  test("compresses vet output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go-vet/vet.input.txt", import.meta.url),
    ).text();
    const out = goVetCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps file.go:LINE:COL: checker: message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go-vet/vet.input.txt", import.meta.url),
    ).text();
    const out = goVetCompressor.compress(input, CTX);
    expect(out).toContain(
      "./handler.go:42:6: composites: example.com/myproject/pkg.Config composite literal uses unkeyed fields",
    );
    expect(out).toContain(
      "./handler.go:58:15: printf: fmt.Printf format %d reads arg #1, but call has 2 args",
    );
    expect(out).toContain(
      "./service.go:15:2: structtag: unknown field tag `jsom` for struct field `Name`",
    );
    expect(out).toContain(
      "./service.go:22:6: lostcancel: the cancel function returned by context.WithCancel should be called, not discarded, to avoid a context leak",
    );
    expect(out).toContain(
      "./main.go:12:5: unreachable: unreachable code",
    );
  });

  test("keeps the exit status N line", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go-vet/vet.input.txt", import.meta.url),
    ).text();
    const out = goVetCompressor.compress(input, CTX);
    expect(out).toContain("exit status 3");
  });

  test("drops the version banner", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go-vet/vet.input.txt", import.meta.url),
    ).text();
    const out = goVetCompressor.compress(input, CTX);
    expect(out).not.toContain("go version go1.22.5");
  });

  test("drops the # package/path section headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/go-vet/vet.input.txt", import.meta.url),
    ).text();
    const out = goVetCompressor.compress(input, CTX);
    expect(out).not.toContain("# example.com/myproject/internal/handler");
    expect(out).not.toContain("# example.com/myproject/internal/service");
    expect(out).not.toContain("# example.com/myproject/internal/store");
  });

  test("tiny input passes through unchanged", () => {
    const input = "./main.go:1:1: printf: oops\n";
    expect(goVetCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not go vet output\nat all\nnothing useful here\n".repeat(20);
    expect(goVetCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = ["go version go1.22.5 linux/amd64"];
    for (let i = 0; i < 9999; i++) {
      lines.push(`# example.com/pkg${i % 10}`);
      lines.push(
        `./file${i}.go:${i}:1: printf: some vet finding number ${i}`,
      );
    }
    lines.push("exit status 3");
    const input = lines.join("\n");
    const t0 = performance.now();
    goVetCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
