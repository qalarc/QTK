// `ansible-playbook` compressor.
//
// Ansible playbook runs (`ansible-playbook site.yml`) emit a stream of per-host
// result lines that is extremely repetitive on a successful run:
//   - `PLAY [target] ***` — one per play (the high-level group).
//   - `TASK [role : task] ***` — one per task, followed by one result line per
//     host. On a 50-host run with 20 tasks, that's 1000 result lines.
//   - `ok: [host]` — the bulk on a successful run (host unchanged). Very
//     repetitive and low-signal: "nothing happened".
//   - `changed: [host]` — host was modified (signal: something happened).
//   - `skipping: [host]` — task skipped for this host (noise).
//   - `fatal: [host]: FAILED! => {...}` — task failed for this host (signal).
//   - `META: ran handlers` — internal bookkeeping (noise).
//   - `[WARNING]` banners — usually inventory/param warnings (noise unless they
//     mention "error" or "fail").
//   - `PLAY RECAP *****` — the per-host summary table (ok/changed/unreachable/
//     failed counts). Dense and high-value.
//   - `ERROR! ...` — playbook syntax / load errors (signal).
//
// The signal lives in:
//   - `PLAY [target]` headers — structural context for what follows.
//   - `TASK [role : task]` headers — but ONLY when the task has at least one
//     changed/failed result (a task with only `ok:` lines is noise; we drop the
//     header too so the output isn't littered with empty task markers).
//   - `fatal: [host]: FAILED!` lines + any JSON/msg detail that follows.
//   - `changed: [host]` lines (something actually happened).
//   - The `PLAY RECAP` table (the whole thing).
//   - `ERROR!` lines.
//
// Strategy: keep PLAY headers, TASK headers (only when they have non-ok
// results), changed/failed result lines + their detail, the PLAY RECAP table,
// and ERROR lines; drop ok/skipping lines, META noise, non-actionable
// [WARNING] banners, and Gathering Facts chatter.
//
// This compressor is LOSSY: it drops `ok:` result lines (the bulk of a
// successful run), `skipping:` lines, `META: ran handlers`, and most
// `[WARNING]` banners. It is NOT reversible. The PLAY RECAP table preserves the
// per-host ok/changed/failed counts, so no information about the run outcome is
// lost — only the repetitive per-task `ok:` lines. Failed tasks keep their full
// output including JSON result dumps.

import type { Compressor } from "../types.ts";

// `PLAY [target] ***` — play header. Keep (structural context).
const PLAY_RE = /^PLAY\s+\[.*?\]\s+\*+/;

// `TASK [role : task] ***` / `TASK [task] ***` — task header. Tracked for
// conditional emission (only kept if the task has changed/failed results).
const TASK_RE = /^TASK\s+\[.*?\]\s+\*+/;

// `RUNNING HANDLER [role : task] ***` — handler header (treated like a task).
const HANDLER_RE = /^RUNNING HANDLER\s+\[.*?\]\s+\*+/;

// `ok: [host]` / `ok: [host] => {...}` — unchanged result. Drop.
const OK_RE = /^ok:\s+\[/;

// `changed: [host]` / `changed: [host] => {...}` — modified result. Keep.
const CHANGED_RE = /^changed:\s+\[/;

// `skipping: [host]` — skipped. Drop.
const SKIPPING_RE = /^skipping:\s+\[/;

// `fatal: [host]: FAILED! => {...}` — failure. Keep.
const FATAL_RE = /^fatal:\s+\[.*?\]:\s+FAILED!/;

// `META: ran handlers` / `META: timed out` — internal bookkeeping. Drop.
const META_RE = /^META:\s+/;

// `[WARNING]` banner. Drop unless it mentions error/fail/deprecated.
const WARNING_RE = /^\[WARNING\]/;

// `PLAY RECAP *****` — start of the recap table. Keep the whole block.
const PLAY_RECAP_RE = /^PLAY RECAP\s+\*+/;

// `NO MORE HOSTS LEFT *****` — abort marker. Keep (explains why run stopped).
const NO_HOSTS_RE = /^NO MORE HOSTS LEFT\s+\*+/;

// `ERROR! ...` — playbook load/syntax error. Keep.
const ERROR_RE = /^ERROR!/;

// A recap table data line: `host : ok=N changed=N unreachable=N failed=N ...`.
// Matched loosely by the `ok=` / `failed=` tokens.
const RECAP_ROW_RE = /^\S+\s*:\s+ok=\d+.*failed=\d+/;

export const ansibleCompressor: Compressor = {
  name: "ansible",
  category: "infra",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `ansible-playbook site.yml`, `ansible-playbook --check site.yml`.
    // Exclude `ansible` (ad-hoc, different output shape) and `ansible-galaxy`.
    return /^ansible-playbook(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State flags:
    //   - pendingTask: a TASK/HANDLER header we've buffered but not yet
    //     committed. We only emit it if a changed/failed result follows.
    //   - inRecap: inside the PLAY RECAP table — keep every data row.
    //   - inFailDetail: just saw a `fatal:` line — keep the indented JSON/msg
    //     continuation lines that ansible prints after a failure.
    let pendingTask: string | null = null;
    let inRecap = false;
    let inFailDetail = false;

    const flushTask = (): void => {
      // Drop a buffered task header (it had only ok/skipping results).
      if (pendingTask !== null) {
        noiseDropped++;
        pendingTask = null;
      }
    };

    const commitTask = (): void => {
      // Emit a buffered task header (a changed/failed result followed).
      if (pendingTask !== null) {
        kept.push(pendingTask);
        pendingTask = null;
      }
    };

    for (const line of lines) {
      // PLAY RECAP header — flush any pending task, keep, enter block.
      if (PLAY_RECAP_RE.test(line)) {
        flushTask();
        inFailDetail = false;
        inRecap = true;
        kept.push(line.trim());
        continue;
      }
      // Inside PLAY RECAP: keep data rows + the trailing blank.
      if (inRecap) {
        if (RECAP_ROW_RE.test(line)) {
          kept.push(line.trim());
          continue;
        }
        if (line.trim() === "") {
          // Blank line ends the recap block.
          inRecap = false;
          continue;
        }
        // Non-row, non-blank inside recap — keep defensively (rare).
        kept.push(line.trim());
        continue;
      }
      // PLAY header — flush pending task, keep.
      if (PLAY_RE.test(line)) {
        flushTask();
        inFailDetail = false;
        kept.push(line.trim());
        continue;
      }
      // TASK / RUNNING HANDLER header — buffer it (conditional emit).
      if (TASK_RE.test(line) || HANDLER_RE.test(line)) {
        flushTask();
        inFailDetail = false;
        pendingTask = line.trim();
        continue;
      }
      // `fatal:` — failure. Commit the task header, keep the line, enter detail.
      if (FATAL_RE.test(line)) {
        commitTask();
        inFailDetail = true;
        kept.push(line.trim());
        continue;
      }
      // `changed:` — something happened. Commit the task header, keep the line.
      if (CHANGED_RE.test(line)) {
        commitTask();
        inFailDetail = false;
        kept.push(line.trim());
        continue;
      }
      // Inside a failure detail block: keep continuation lines (JSON dumps,
      // indented msg output) until a blank line or a new structural marker.
      if (inFailDetail) {
        if (line.trim() === "") {
          inFailDetail = false;
          continue;
        }
        // A new PLAY/TASK/RECAP header ends the detail block — fall through.
        if (
          PLAY_RE.test(line) ||
          TASK_RE.test(line) ||
          HANDLER_RE.test(line) ||
          PLAY_RECAP_RE.test(line) ||
          NO_HOSTS_RE.test(line)
        ) {
          inFailDetail = false;
          // Fall through to re-process this line below.
        } else {
          kept.push(line);
          continue;
        }
      }
      // `ok:` — unchanged. Drop (flushes any pending task implicitly).
      if (OK_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `skipping:` — skipped. Drop.
      if (SKIPPING_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `META:` — internal bookkeeping. Drop.
      if (META_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `[WARNING]` — drop unless actionable.
      if (WARNING_RE.test(line)) {
        if (/\b(error|fail|deprecated)\b/i.test(line)) {
          commitTask();
          kept.push(line.trim());
        } else {
          noiseDropped++;
        }
        continue;
      }
      // `NO MORE HOSTS LEFT` — abort marker. Keep.
      if (NO_HOSTS_RE.test(line)) {
        flushTask();
        inFailDetail = false;
        kept.push(line.trim());
        continue;
      }
      // `ERROR!` — playbook error. Keep.
      if (ERROR_RE.test(line)) {
        flushTask();
        inFailDetail = false;
        kept.push(line.trim());
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like a failure/detail.
      if (/\b(failed|fatal|error|traceback)\b/i.test(line)) {
        commitTask();
        kept.push(line.trim());
        continue;
      }
      noiseDropped++;
    }

    // Flush a trailing buffered task (rare — usually followed by recap).
    flushTask();

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
