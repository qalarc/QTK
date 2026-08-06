// `npm install` / `pnpm install` / `yarn install` compressor.
//
// Package-manager install output is extremely verbose:
//   - `npm install` prints a progress line per package, then a tree of
//     `added 412 packages in 12s` plus the full dependency tree
//   - `pnpm install` prints a progress table and a "Done in 4.2s" line
//   - `yarn install` prints per-package resolution lines
//
// For the model, almost all of this is noise. What matters:
//   - Did it succeed? (the `added N packages` / `Done in` / `success` line)
//   - Any warnings or vulnerabilities? (`npm WARN`, `npm audit`, deprecations)
//   - Any errors? (`npm ERR!`)
//
// Strategy: keep the summary line + warnings/errors + deprecation notices,
// drop the per-package progress and the dependency tree.

import type { Compressor } from "../types.ts";

// Lines that are pure progress noise.
const NOISE_RE =
  /^\s*(npm\s+WARN\s+deprecated|npm\s+WARN|npm\s+ERR!|added|removed|changed|found|run\s+audit|Done in|\d+\s+packages|├──|└──|│|`--|\.|--)/;

// A summary line we always want to keep.
// Matches: "added 412 packages in 12s" or "added 412 packages, and audited 413 packages in 12s"
const SUMMARY_RE =
  /^\s*(added|removed|changed)\s+\d+\s+packages?\b/;

// pnpm summary: "Done in 4.21s."
const PNPM_DONE_RE = /^\s*Done in\s+[\d.]+s/;
// yarn summary: "success Saved lockfile." / "Done in"
const YARN_DONE_RE = /^\s*(success|info)\s+/;

// Deprecation warnings are important — keep them.
const DEPRECATION_RE = /deprecated/i;

// npm audit severity lines.
const AUDIT_RE = /^\s*(\d+)\s+(low|moderate|high|critical)\s+severity/i;
// "found N vulnerabilities" summary line.
const VULN_RE = /^\s*found\s+\d+\s+vulnerabilit/i;

// Error lines always kept.
const ERROR_RE = /^\s*npm\s+ERR!/;
const WARN_RE = /^\s*npm\s+WARN/;

export const npmCompressor: Compressor = {
  name: "npm",
  category: "package-manager",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    // Match `npm install`, `npm i`, `pnpm install`/`pnpm i`, `yarn install`/`yarn`.
    // Exclude piped/compound commands.
    if (/[|&;><]/.test(cmd)) return false;
    if (/^npm\s+(install|i|ci)\b/.test(cmd)) return true;
    if (/^pnpm\s+(install|i|add|ci)\b/.test(cmd)) return true;
    if (/^yarn\s+(install|add)\b/.test(cmd)) return true;
    return false;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const summary: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const audit: string[] = [];
    let progressDropped = 0;

    for (const line of lines) {
      // Always keep the summary line.
      if (SUMMARY_RE.test(line) || PNPM_DONE_RE.test(line)) {
        summary.push(line.trim());
        continue;
      }
      // Errors are critical.
      if (ERROR_RE.test(line)) {
        errors.push(line.trim());
        continue;
      }
      // Warnings — keep deprecations and audit, drop generic noise.
      if (WARN_RE.test(line) || YARN_DONE_RE.test(line)) {
        if (DEPRECATION_RE.test(line)) {
          warnings.push(line.trim());
        }
        continue;
      }
      // Audit severity counts.
      const auditMatch = line.match(AUDIT_RE);
      if (auditMatch) {
        audit.push(line.trim());
        continue;
      }
      // "found N vulnerabilities" summary.
      if (VULN_RE.test(line)) {
        audit.push(line.trim());
        continue;
      }
      // Anything that looks like progress/tree noise.
      if (NOISE_RE.test(line) || line.trim() === "") {
        if (line.trim() !== "") progressDropped++;
        continue;
      }
      // Unknown line — drop it (aggressive reduction). We only keep what we
      // explicitly recognise as signal; unrecognised lines are almost always
      // progress/tree noise in package-manager output.
      progressDropped++;
    }

    // If we found nothing meaningful, return raw (don't make things worse).
    if (
      summary.length === 0 &&
      warnings.length === 0 &&
      errors.length === 0 &&
      audit.length === 0
    ) {
      return raw;
    }

    const out: string[] = [];
    if (summary.length > 0) {
      out.push(summary.join("; "));
    }
    if (errors.length > 0) {
      out.push("");
      out.push(`${errors.length} error(s):`);
      out.push(...errors.slice(0, 20));
      if (errors.length > 20) out.push(`... +${errors.length - 20} more`);
    }
    if (audit.length > 0) {
      out.push("");
      out.push("audit:");
      out.push(...audit.slice(0, 10));
    }
    if (warnings.length > 0) {
      out.push("");
      out.push(`${warnings.length} warning(s):`);
      out.push(...warnings.slice(0, 15));
      if (warnings.length > 15) out.push(`... +${warnings.length - 15} more`);
    }
    if (progressDropped > 0) {
      out.push(`(${progressDropped} progress/tree lines dropped)`);
    }

    const result = out.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};
