// `sqlfluff` compressor.
//
// SQLFluff (`sqlfluff lint` / `sqlfluff lint src/`) is a SQL linter. Its
// default output emits findings one per line:
//
//   == [src/models/users.sql] FAIL
//   L:   5 | P:   1 | L014 | Unqualified reference 'name' found in single table
//   | select.
//   L:  10 | P:   5 | L010 | Keywords must be consistently upper case.
//   L:  15 | P:   1 | L016 | Line is too long (120 > 80).
//   == [src/models/orders.sql] FAIL
//   L:   8 | P:   3 | L028 | Reference 'id' refers to table 'orders' which is
//   | not in the FROM clause.
//   L:  20 | P:   1 | CP01 | Keywords must be consistently upper case.
//
// SQLFluff also supports `--format=json` (a JSON array of per-file objects with
// `violations` arrays) and `--format=yaml`. We detect and parse JSON too.
//
// The signal lives in:
//   - The `== [file] FAIL` file headers (group findings by file).
//   - The `L: LINE | P: COL | CODE | message` finding lines. The code (L014,
//     L010, CP01, AM04, ...) + the location + the message are all actionable.
//   - The continuation lines (SQLFluff wraps long messages with a leading `|`).
//
// The bulk that CAN be compressed:
//   - The version banner (`sqlfluff version` is printed on some invocations).
//   - The `All Finished 📜 🎉!` epilogue.
//   - The decorative blank-line separators.
//
// Strategy: keep file headers, finding lines, and continuations; drop the
// version banner and the `All Finished` epilogue. This mirrors the
// eslint/ruff pattern (lint findings with codes — drop the runner epilogue).
//
// This compressor is LOSSY: it drops the version banner and the `All Finished`
// epilogue. It is NOT reversible. Every finding (code + message + file + line +
// col) is preserved.

import type { Compressor } from "../types.ts";

// JSON mode: sqlfluff `--format=json` emits a JSON array of per-file objects.
// We detect it by sniffing for a leading `[` where the content includes
// `"filepath"` or `"violations"`.
const JSON_ARRAY_RE = /^\s*\[[\s\S]*"(filepath|violations)"\s*:/;

// File header: `== [path] FAIL`. Keep (groups findings by file).
const FILE_HEADER_RE = /^==\s*\[[^\]]+\]\s+FAIL/;

// Finding line: `L: LINE | P: COL | CODE | message`. The code is an
// alphanumeric rule ID (L014, CP01, AM04, RF01, ...). Keep. We anchor on
// `L: NUM | P: NUM | CODE |`.
const FINDING_RE = /^L:\s*\d+\s*\|\s*P:\s*\d+\s*\|/;

// Continuation line: `| <text>` (SQLFluff wraps long messages with a leading
// `|`). Keep — it completes the preceding finding.
const CONTINUATION_RE = /^\|/;

// Version banner: `sqlfluff 2.x.x` / `sqlfluff: version ...`. Drop.
const VERSION_RE = /^sqlfluff[:\s]+\d+\.\d+/i;

// `All Finished 📜 🎉!` epilogue. Drop.
const FINISHED_RE = /^All\s+Finished/i;

export const sqlfluffCompressor: Compressor = {
  name: "sqlfluff",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `sqlfluff lint`, `sqlfluff lint src/`, `sqlfluff lint --rules L010 .`.
    // EXCLUDE `sqlfluff --version`, `sqlfluff version`, `sqlfluff fix` (that
    // MUTATES files), `sqlfluff format`, `sqlfluff parse`, `sqlfluff rules`
    // (lists rules), `sqlfluff dialects`.
    if (/sqlfluff\s+--?version\b/.test(cmd)) return false;
    if (/sqlfluff\s+version\b/.test(cmd)) return false;
    if (/sqlfluff\s+fix\b/.test(cmd)) return false;
    if (/sqlfluff\s+format\b/.test(cmd)) return false;
    if (/sqlfluff\s+parse\b/.test(cmd)) return false;
    if (/sqlfluff\s+rules\b/.test(cmd)) return false;
    if (/sqlfluff\s+dialects\b/.test(cmd)) return false;
    return /^sqlfluff\s+lint(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    // JSON mode: parse the structured output and re-emit a compact text form.
    if (JSON_ARRAY_RE.test(raw)) {
      return compressJson(raw);
    }

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // File header — keep.
      if (FILE_HEADER_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Finding line — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Continuation line (`| <text>`) — keep.
      if (CONTINUATION_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `All Finished` epilogue — drop.
      if (FINISHED_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|fatal)\b/i.test(line)) {
        kept.push(line);
        continue;
      }
      noiseDropped++;
    }

    // If we found nothing meaningful, return raw.
    if (kept.length === 0) return raw;

    if (noiseDropped > 0) {
      kept.push(`(${noiseDropped} noise lines dropped)`);
    }

    const result = kept.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};

/**
 * Parse sqlfluff `--format=json` output and re-emit a compact text form.
 *
 * Shape: a JSON array of per-file objects:
 *   [
 *     {
 *       "filepath": "src/models/users.sql",
 *       "violations": [
 *         { "line_no": 5, "line_pos": 1, "code": "L014", "description": "..." },
 *         ...
 *       ]
 *     },
 *     ...
 *   ]
 *
 * On any parse error, return `raw` unchanged (the cardinal rule).
 */
function compressJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // malformed JSON — pass through unchanged
  }
  if (!Array.isArray(parsed)) return raw;

  const out: string[] = [];
  let total = 0;

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.filepath === "string" ? e.filepath : "?";
    const violations = e.violations;
    if (!Array.isArray(violations)) continue;
    if (violations.length > 0) {
      out.push(`== [${file}] FAIL`);
    }
    for (const v of violations) {
      if (typeof v !== "object" || v === null) continue;
      const o = v as Record<string, unknown>;
      const line = typeof o.line_no === "number" ? o.line_no : "?";
      const pos = typeof o.line_pos === "number" ? o.line_pos : "?";
      const code = typeof o.code === "string" ? o.code : "?";
      const desc = typeof o.description === "string" ? o.description : "";
      out.push(`L: ${line} | P: ${pos} | ${code} | ${desc}`);
      total++;
    }
  }

  if (out.length > 0) {
    out.push(`(${total} violations found)`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}
