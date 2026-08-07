// `luacheck` compressor.
//
// Luacheck (`luacheck .` / `luacheck src/`) is a Lua linter. Its default output
// emits findings one per line:
//
//   Checking src/init.lua                                  4 warnings
//
//   src/init.lua:2:1: (W111) setting non-standard global variable 'path'
//   src/init.lua:5:10: (W112) accessing undefined variable 'undefined_fn'
//   src/init.lua:10:1: (W113) setting non-standard global variable 'config'
//   src/utils.lua:8:3: (W211) unused variable 'helper'
//   src/utils.lua:15:1: (W212) unused argument 'self'
//   src/handlers.lua:20:5: (E011) expected statement near '='
//   src/handlers.lua:30:1: (W314) trailing whitespace in a string
//
//   Total: 1 error / 6 warnings in 3 files
//
// The signal lives in:
//   - The `file:LINE:COL: (CODE) message` finding lines. The code is a letter
//     (E/W) + 3 digits: E=Error, W=Warning. The message + location are all
//     actionable.
//   - The `Total: N errors / M warnings in K files` summary.
//
// The bulk that CAN be compressed:
//   - The `Checking <file>` per-file progress lines (the per-file warning count
//     is derivable from the finding lines that follow).
//   - The `Files: N` / `Lines: N` / `Checks: N` stat block (luacheck prints
//     these when `--formatter plain` is used with `--ranges`/`--codes`).
//   - The decorative blank-line separators.
//
// Strategy: keep finding lines and the `Total:` summary; drop the `Checking`
// progress lines and the stat block. This mirrors the ruff/eslint pattern (lint
// findings with codes — drop the per-file progress chatter).
//
// This compressor is LOSSY: it drops the `Checking <file>` progress lines and
// the stat block. It is NOT reversible. Every finding (code + message + file +
// line + col) and the summary are preserved.

import type { Compressor } from "../types.ts";

// Finding line: `file:LINE:COL: (CODE) message`. The code is E/W + digits.
// Path may be relative (`./`) or absolute. Keep. We anchor on
// `path:NUM:NUM: (LETTER` to avoid matching arbitrary text.
const FINDING_RE = /^[\w./@-]+:\d+:\d+:\s+\([EW]\d+\)/;

// Summary: `Total: N error(s) / M warning(s) in K files`. Keep.
const TOTAL_RE = /^Total:\s+\d+\s+error/i;

// Stat block lines: `Files: N`, `Lines: N`, `Checks: N`, `Globals: N`,
// `Fields: N`. Drop (low-value aggregate stats).
const STAT_RE = /^(Files|Lines|Checks|Globals|Fields|Clear|Allow|Std|Config)\s*:/i;

// `Checking <file>` per-file progress line. Drop. Luacheck prints one per file
// with a right-aligned warning count.
const CHECKING_RE = /^Checking\s+\S+/i;

export const luacheckCompressor: Compressor = {
  name: "luacheck",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `luacheck .`, `luacheck src/`, `luacheck --codes .`, `luacheck *.lua`.
    // EXCLUDE `luacheck --version`, `luacheck --help`.
    if (/^luacheck\s+--?version\b/.test(cmd)) return false;
    if (/^luacheck\s+--?help\b/.test(cmd)) return false;
    return /^luacheck\b/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;

    for (const line of lines) {
      // Finding line — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `Total:` summary — keep.
      if (TOTAL_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `Checking <file>` progress — drop.
      if (CHECKING_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Stat block — drop.
      if (STAT_RE.test(line)) {
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
