// `shellcheck` compressor.
//
// Shellcheck (`shellcheck *.sh`) emits findings in a fixed 3-line block per
// issue:
//   1. `In <file> line N:` — the location header.
//   2. The offending source line (verbatim from the file).
//   3. `^-- SCxxxx (severity): message.` — the caret pointing at the column +
//      the SC code, severity (error/warning/info/style), and message.
//
// On a script with many issues (common: SC2086 "double quote" appears dozens
// of times), the output is repetitive but every finding is actionable. The
// bulk that CAN be compressed:
//   - The `For more information:` epilogue + the wiki URL list (one URL per
//     distinct SC code). These are pure references — the SC code + message is
//     already in the finding line. Dropping them loses nothing actionable.
//   - Repeated source lines: if the same source line triggers N findings
//     (e.g. an unquoted variable used 5 times on one line), shellcheck prints
//     the source line once with N carets. We keep that as-is (it's already
//     deduped by shellcheck itself).
//
// The signal lives in:
//   - The `In <file> line N:` location headers.
//   - The source lines (context for the finding).
//   - The `^-- SCxxxx (severity): message.` finding lines.
//
// Strategy: keep location headers, source lines, and finding lines; drop the
// `For more information:` epilogue and the wiki URL list. Also collapse
// consecutive blank lines (shellcheck separates files with blanks).
//
// This compressor is LOSSY: it drops the `For more information:` wiki URL
// epilogue. It is NOT reversible. Every finding (SC code + severity + message
// + file + line + source) is preserved — the URLs are derivable from the SC
// codes (`https://www.shellcheck.net/wiki/SCxxxx`).

import type { Compressor } from "../types.ts";

// `In <file> line N:` — location header. Keep.
const LOCATION_RE = /^In\s+\S+\s+line\s+\d+:/;

// `^-- SCxxxx (severity): message.` — finding line. The caret is made of `^`
// and `~` chars with leading spaces. Keep.
const FINDING_RE = /^\s*\^[-~]+\s+SC\d{4}\s+\(/;

// `For more information:` — epilogue header. Drop (starts the URL block).
const MORE_INFO_RE = /^For more information:/;

// Wiki URL line: `  https://www.shellcheck.net/wiki/SCxxxx -- ...`. Drop.
const WIKI_URL_RE = /^\s*https?:\/\/\S*shellcheck\S*\/wiki\/SC\d{4}/;

export const shellcheckCompressor: Compressor = {
  name: "shellcheck",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `shellcheck *.sh`, `shellcheck deploy.sh`, `shellcheck -x script.sh`.
    // Exclude `shellcheck --version` (not a lint run).
    if (/^shellcheck\s+--version/.test(cmd)) return false;
    return /^shellcheck(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inUrls — inside the `For more information:` wiki URL block. Once
    // entered, we drop URL lines until a blank or non-URL line.
    let inUrls = false;

    for (const line of lines) {
      // `For more information:` — start of URL epilogue. Drop.
      if (MORE_INFO_RE.test(line)) {
        inUrls = true;
        noiseDropped++;
        continue;
      }
      // Inside URL block: drop wiki URL lines.
      if (inUrls) {
        if (WIKI_URL_RE.test(line)) {
          noiseDropped++;
          continue;
        }
        // A non-URL line ends the URL block. Blank lines also end it.
        if (line.trim() === "") {
          inUrls = false;
          continue;
        }
        inUrls = false;
        // Fall through to re-process this line below.
      }
      // Location header — keep.
      if (LOCATION_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Finding line (`^-- SCxxxx (...)`) — keep.
      if (FINDING_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Blank lines — drop (collapse separators between files).
      if (line.trim() === "") {
        continue;
      }
      // Any other non-blank line between a location header and a finding is the
      // source line (context). We keep it ONLY if the previous kept line was a
      // location header or a finding line (i.e. we're inside a finding block).
      // This prevents keeping arbitrary garbage on non-shellcheck input.
      const lastKept = kept.length > 0 ? kept[kept.length - 1] : "";
      if (LOCATION_RE.test(lastKept) || FINDING_RE.test(lastKept)) {
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
