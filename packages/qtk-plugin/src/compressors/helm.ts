// `helm` compressor.
//
// Helm (`helm install`, `helm upgrade`, `helm rollback`) emits a predictable
// stream on a successful release operation:
//   - `NAME: <release>` — the release name. One line.
//   - `LAST DEPLOYED: <date>` / `NAMESPACE: <ns>` / `STATUS: deployed` /
//     `REVISION: <n>` — the release status block. Five lines total.
//   - `TEST SUITE:` / test-runner output (when `--test` is used).
//   - `NOTES:` — the chart's post-install instructions (often multi-line,
//     indented). This is the actionable content the user needs.
//   - `Warning:` lines (e.g. failed hooks, deprecated APIs).
//   - `Error:` lines / `coalesce.go: warning:` template-coalescing errors.
//
// On failure (`helm install` hits a missing dependency, a template error, or a
// hook failure), the output is dominated by `Error:` / `coalesce.go: warning:`
// / `execution error` lines — those are the signal.
//
// DESIGN DECISION — `helm template` is EXCLUDED from this compressor.
// `helm template` renders the chart to YAML — that rendered YAML IS the
// intended output (the user ran the command specifically to get it). Stripping
// it would destroy the value. So this compressor only matches
// `install` / `upgrade` / `rollback`, where the rendered manifests are NOT
// printed and the bulk of output is status/notes/errors.
//
// The signal lives in:
//   - The release status block: `NAME:` / `LAST DEPLOYED:` / `NAMESPACE:` /
//     `STATUS:` / `REVISION:`.
//   - `NOTES:` section (post-install instructions).
//   - `Error:` lines (install/upgrade/rollback failures).
//   - `coalesce.go: warning:` lines (template validation errors — these are
//     the most common cause of a failed `helm upgrade`).
//   - `Warning:` lines about failed hooks or deprecated APIs.
//
// Strategy: keep the status block, NOTES section, errors, coalesce warnings,
// and hook warnings; drop `Creating`/`Deleting` progress noise, release-info
// chatter, and blank-line separators.
//
// This compressor is LOSSY: it drops progress noise (`Creating`/`Deleting`
// lines) and release-info chatter. It is NOT reversible. The status block,
// NOTES, errors, and warnings are preserved verbatim.

import type { Compressor } from "../types.ts";

// Release status block keys. Keep.
const STATUS_KEY_RE =
  /^(NAME|LAST DEPLOYED|NAMESPACE|STATUS|REVISION):\s+.+/;

// `NOTES:` — start of the post-install notes section. Keep (and keep the
// indented content that follows).
const NOTES_RE = /^NOTES:\s*$/;

// `Error:` / `Error: ...` — install/upgrade/rollback failure. Keep.
const ERROR_RE = /^Error:/;

// `coalesce.go: warning: ...` — template validation/coalescing errors. These
// are the #1 cause of a failed `helm upgrade` (duplicate keys, wrong types).
// Keep.
const COALESCE_RE = /^coalesce\.go:\s+warning:/;

// `Warning:` / `WARNING:` — failed hooks, deprecated APIs. Keep.
const WARNING_RE = /^(WARNING|Warning):\s+/;

// `execution error at` — helm template execution failure. Keep.
const EXEC_ERROR_RE = /^execution error at/;

// Progress noise: `#`-prefixed manifest comments from `helm install --dry-run`,
// `Creating`/`Deleting`/`Wiping` release-info chatter. Drop.
const PROGRESS_RE =
  /^(Creating|Deleting|Wiping|Rolling back|Building|Updating)\s/;

// `Manifest is not valid YAML` / dry-run manifest comment lines (`# Source:`).
// Drop (dry-run noise; the user wants the status, not the rendered manifest).
const SOURCE_COMMENT_RE = /^#\s+(Source|Manifest)/;

export const helmCompressor: Compressor = {
  name: "helm",
  category: "infra",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `helm install`, `helm upgrade`, `helm rollback`. EXCLUDE `helm template`
    // (rendered YAML is the intended output — see module docstring).
    // EXCLUDE `helm version`, `helm list`, `helm repo` (different shapes).
    return /^helm\s+(install|upgrade|rollback)(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State: inNotes — inside the `NOTES:` section. Keep indented content lines
    // until a blank line or a non-indented structural line ends it.
    let inNotes = false;

    for (const line of lines) {
      // Error — always keep, ends notes block.
      if (ERROR_RE.test(line)) {
        kept.push(line.trim());
        inNotes = false;
        continue;
      }
      // Coalesce warning — always keep.
      if (COALESCE_RE.test(line)) {
        kept.push(line.trim());
        inNotes = false;
        continue;
      }
      // Execution error — always keep.
      if (EXEC_ERROR_RE.test(line)) {
        kept.push(line.trim());
        inNotes = false;
        continue;
      }
      // Warning (hook failures, deprecated APIs) — keep.
      if (WARNING_RE.test(line)) {
        kept.push(line.trim());
        inNotes = false;
        continue;
      }
      // Release status block key — keep.
      if (STATUS_KEY_RE.test(line)) {
        kept.push(line.trim());
        inNotes = false;
        continue;
      }
      // NOTES: marker — keep, enter notes block.
      if (NOTES_RE.test(line)) {
        kept.push(line.trim());
        inNotes = true;
        continue;
      }
      // Inside notes block: keep content lines (indented or non-blank prose).
      if (inNotes) {
        // A blank line ends the notes block.
        if (line.trim() === "") {
          inNotes = false;
          continue;
        }
        kept.push(line);
        continue;
      }
      // Progress noise — drop.
      if (PROGRESS_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Dry-run source comments — drop.
      if (SOURCE_COMMENT_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|panic)\b/i.test(line)) {
        kept.push(line.trim());
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
