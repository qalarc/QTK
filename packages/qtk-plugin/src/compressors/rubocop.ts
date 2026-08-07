// `rubocop` compressor.
//
// RuboCop (`rubocop` / `bundle exec rubocop` / `rubocop app/`) emits lint
// findings, one per line, tagged with a severity letter and a rule name:
//
//   Inspecting 18 files
//   ..................
//   ..................
//
//   app/models/user.rb:10:5: C: Style/StringLiterals: Prefer single-quoted strings...
//   app/models/user.rb:15:1: C: Layout/IndentationWidth: Use 2 (not 4) spaces for indentation.
//   app/controllers/users_controller.rb:8:7: W: Rails/OutputSafety: ...
//   app/helpers/application_helper.rb:3:1: C: Style/Documentation: Missing top-level class documentation comment.
//   lib/tasks/db.rake:12:5: E: Lint/Syntax: unexpected token tCOMMA
//   config/initializers/secret.rb:5:1: F: Lint/UselessAssignment: Useless assignment to variable...
//
//   18 files inspected, 47 offenses detected
//   18 files inspected, 47 offenses detected, 23 offenses auto-correctable
//
// The signal lives in:
//   - The `file.rb:LINE:COL: SEV: RuleName: message` finding lines. The
//     severity is a single letter: C=Convention, R=Refactor, W=Warning,
//     E=Error, F=Fatal. The RuleName (e.g. `Style/StringLiterals`,
//     `Rails/OutputSafety`, `Lint/Syntax`) is the actionable identifier.
//   - The `N files inspected, M offenses detected` summary (optionally with
//     `, K offenses auto-correctable`).
//
// The bulk that CAN be compressed:
//   - The `Inspecting N files` progress line.
//   - The dotted progress bar (`.` and `*` lines — one dot per file).
//   - The version banner (`rubocop 1.64.1` — only with `--version`, but can
//     leak into CI logs).
//   - Watch-mode chatter (`RuboCop is running in watch mode`, `For more
//     information:`, rule-doc URLs).
//   - The decorative `1 offense in 1 file` epilogue rubocop sometimes prints.
//
// Strategy: keep finding lines + the `N files inspected, M offenses detected`
// summary; drop the progress line, dotted progress bar, version banner, and
// watch-mode chatter. This mirrors the pylint/eslint pattern (lint findings
// with codes — drop the decorative epilogue).
//
// This compressor is LOSSY: it drops the `Inspecting N files` progress line,
// the dotted progress bar, the version banner, and watch-mode chatter. It is
// NOT reversible. Every finding (severity + rule + message + file + line +
// col) and the inspection summary are preserved.

import type { Compressor } from "../types.ts";

// Finding line: `file.rb:LINE:COL: SEV: RuleName: message`.
// The severity is a single letter (C/R/W/E/F). The RuleName is a CamelCase
// identifier, optionally with a namespace (`Style/...`, `Lint/...`,
// `Rails/...`, `Metrics/...`, `Naming/...`, `Security/...`, `Bundler/...`,
// `Gemspec/...`). Keep.
// We anchor on `path:NUM:NUM: L:` — the path may contain `/`, `.`, `-`, `_`.
const FINDING_RE = /^[\w./@-]+\.r(?:b|ake|b|builder|gemspec|jbuilder|rabl):\d+:\d+:\s+[CRWEF]:/;

// Summary: `N files inspected, M offenses detected` (optionally with
// `, K offenses auto-correctable`). Keep.
const SUMMARY_RE = /^\d+\s+files?\s+inspected,\s+\d+\s+offenses?\s+detected/;

// `Inspecting N files` progress line. Drop.
const INSPECTING_RE = /^Inspecting\s+\d+\s+files?/;

// Dotted progress bar: a line of only `.` and/or `*` (one per file). Drop.
const DOTS_RE = /^[.*]+$/;

// Version banner: `rubocop 1.64.1` / `rubocop-1.64.1`. Drop.
const VERSION_RE = /^rubocop[-:]?\s+v?\d/;

// Watch-mode chatter. Drop.
const WATCH_RE = /^(RuboCop is running in watch mode|For more information|Run `rubocop)/;

// `N offense(s) in M file(s)` — alternative epilogue rubocop sometimes prints.
// Drop (the `files inspected, offenses detected` summary is the canonical one).
const OFFENSE_EPILOGUE_RE = /^\d+\s+offenses?\s+in\s+\d+\s+files?/;

export const rubocopCompressor: Compressor = {
  name: "rubocop",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `rubocop`, `rubocop app/`, `bundle exec rubocop`, `rubocop --only Style`.
    // EXCLUDE `rubocop --version` (not a lint run), `rubocop -a`/`--auto-correct`
    // (that MUTATES files — its output is the corrected file list, different
    // shape), `rubocop --generate-config`, `rubocop --show-cops`.
    if (/rubocop\s+--version/.test(cmd)) return false;
    if (/rubocop\s+--auto-correct/.test(cmd)) return false;
    if (/rubocop\s+-a\b/.test(cmd)) return false;
    if (/rubocop\s+-A\b/.test(cmd)) return false;
    if (/rubocop\s+--generate-config/.test(cmd)) return false;
    if (/rubocop\s+--show-cops/.test(cmd)) return false;
    return /(^|\s)(bundle\s+exec\s+)?rubocop(\s|$)/.test(cmd);
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
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `Inspecting N files` progress — drop.
      if (INSPECTING_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Dotted progress bar — drop.
      if (DOTS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Watch-mode chatter — drop.
      if (WATCH_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `N offenses in M files` epilogue — drop.
      if (OFFENSE_EPILOGUE_RE.test(line)) {
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
