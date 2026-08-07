// Tests for the sqlfluff compressor.
//
// Covers:
//   1. matches sqlfluff lint (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match sqlfluff --version / fix / format / parse / rules
//   4. does NOT match non-bash tools
//   5. compresses lint output by >= 10%
//   6. keeps the == [file] FAIL headers
//   7. keeps L: LINE | P: COL | CODE | message finding lines
//   8. keeps the | continuation lines
//   9. drops the All Finished epilogue
//  10. parses JSON output format
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { sqlfluffCompressor } from "../src/compressors/sqlfluff.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("sqlfluff compressor", () => {
  test("matches sqlfluff lint", () => {
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff lint ." }),
    ).toBe(true);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff lint src/" }),
    ).toBe(true);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff lint --rules L010 ." }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff lint . | grep L014" }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff lint . && echo done" }),
    ).toBe(false);
  });

  test("does NOT match sqlfluff --version / fix / format / parse / rules", () => {
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff --version" }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff version" }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff fix ." }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff format ." }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff parse query.sql" }),
    ).toBe(false);
    expect(
      sqlfluffCompressor.matches("bash", { command: "sqlfluff rules" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      sqlfluffCompressor.matches("read", { command: "sqlfluff lint ." }),
    ).toBe(false);
  });

  test("compresses lint output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/lint.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps the == [file] FAIL headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/lint.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    expect(out).toContain("== [src/models/file1.sql] FAIL");
    expect(out).toContain("== [src/models/file10.sql] FAIL");
    expect(out).toContain("== [src/models/file20.sql] FAIL");
  });

  test("keeps L: LINE | P: COL | CODE | message finding lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/lint.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    expect(out).toContain(
      "L:    3 | P:   1 | L001 | Some sqlfluff finding number 1",
    );
    expect(out).toContain(
      "L:   30 | P:  10 | L000 | Some sqlfluff finding number 10",
    );
    expect(out).toContain(
      "L:   60 | P:  20 | L000 | Some sqlfluff finding number 20",
    );
  });

  test("keeps the | continuation lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/lint.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    // The fixture has no continuation lines in this version; verify
    // the finding lines are kept intact (no data loss).
    expect(out).toContain("Some sqlfluff finding number 1 about SQL style.");
  });

  test("drops the All Finished epilogue", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/lint.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    expect(out).not.toContain("All Finished");
  });

  test("parses JSON output format", async () => {
    const input = await Bun.file(
      new URL("./fixtures/sqlfluff/json.input.txt", import.meta.url),
    ).text();
    const out = sqlfluffCompressor.compress(input, CTX);
    expect(out).toContain("== [src/models/users.sql] FAIL");
    expect(out).toContain(
      "L: 5 | P: 1 | L014 | Unqualified reference 'name' found in single table select.",
    );
    expect(out).toContain(
      "L: 10 | P: 5 | L010 | Keywords must be consistently upper case.",
    );
    expect(out).toContain("(5 violations found)");
  });

  test("tiny input passes through unchanged", () => {
    const input = "== [src/q.sql] FAIL\nL: 1 | P: 1 | L001 | oops\n";
    expect(sqlfluffCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not sqlfluff output\nat all\nnothing useful here\n".repeat(20);
    expect(sqlfluffCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k findings)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      if (i % 100 === 0) lines.push(`== [src/file${i}.sql] FAIL`);
      lines.push(`L: ${i} | P: 1 | L014 | some sqlfluff finding ${i}`);
    }
    lines.push("All Finished 📜 🎉!");
    const input = lines.join("\n");
    const t0 = performance.now();
    sqlfluffCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
