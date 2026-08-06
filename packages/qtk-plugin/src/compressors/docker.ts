// `docker ps` / `docker build` / `docker compose up` compressor.
//
// Docker CLI output is verbose in three distinct ways:
//   - `docker ps -a`: a wide table where the CONTAINER ID column is a
//     12-char hex hash that's almost never actionable (the model rarely
//     needs to `docker exec` by raw ID). The IMAGE, STATUS, and NAMES
//     columns carry the meaning. A wall of `Up 5 minutes` rows is noise.
//   - `docker build`: prints `Step N/N :` for every layer plus
//     `---> <hash>` / `Removing intermediate container <hash>` / `Running in`
//     noise. What matters: the final `Successfully built <hash>` /
//     `Successfully tagged <image>` summary, plus any ERROR lines.
//   - `docker compose up`: prints pull noise (`Pulling fs layer`,
//     `<hash>: Pull complete`, `Digest:`, `Status: Downloaded`), then
//     per-service log lines prefixed with the service name. What matters:
//     service start/stop state changes, ERROR lines, and exit codes.
//
// Strategy:
//   - `docker ps` table: keep header + summary + anomalous rows (Exited,
//     Restarting, unhealthy, Created), drop healthy `Up` rows.
//   - `docker build`: keep `Successfully built`/`Successfully tagged` +
//     ERROR/warning lines, drop `Step N/N` + hash + intermediate noise.
//   - `docker compose up`: keep service state changes + ERROR lines +
//     exit codes, drop pull noise + generic log spam.
//
// This compressor is intentionally LOSSY: it summarises healthy state and
// surfaces anomalies. It is NOT reversible — the dropped lines are gone.

import type { Compressor } from "../types.ts";

// ─── docker ps table ────────────────────────────────────────────────────────

// Header detection: first column is CONTAINER ID (or NAMESPACE for `docker ps`).
const PS_HEADER_RE = /^(CONTAINER ID|NAMESPACE)\s+.*\b(STATUS|IMAGE|NAMES)\b/;

// A healthy row: contains "Up" status (optionally "(healthy)") and no anomaly.
// Matches: "abc123   nginx:latest   ...   Up 5 minutes   ...   web-server"
const PS_HEALTHY_RE = /\bUp\b\s+(\d+|\w+)/;

// Anomalous statuses the model needs to see.
const PS_ANOMALY_RE =
  /\b(Exited|Restarting|Created|Paused|Dead|Removal|unhealthy|OOMKilled)\b/i;

const PS_MAX_ROWS = 20;

// ─── docker build ───────────────────────────────────────────────────────────

// `Step 1/20 : FROM ...` — intermediate build-step noise.
const BUILD_STEP_RE = /^Step\s+\d+\/\d+\s*:/;
// ` ---> <hash>` layer-id noise.
const BUILD_HASH_RE = /^\s*--->\s+[0-9a-f]+/i;
// `Removing intermediate container <hash>` / `Running in <hash>`.
const BUILD_INTERMEDIATE_RE =
  /^(Removing intermediate container|Running in)\s+/;
// Build summary lines we always keep.
const BUILD_SUMMARY_RE = /^(Successfully built|Successfully tagged)\b/i;
// Build errors / warnings.
const BUILD_ERROR_RE = /^(ERROR|error:|warning:|WARN)\b/i;

// ─── docker compose up ──────────────────────────────────────────────────────

// Pull noise: `Pulling <svc> (<image>)...`, `<hash>: Pull complete`, etc.
const COMPOSE_PULL_RE =
  /^(Pulling|[\da-f]+:\s+(Pull|Waiting|Downloading|Extracting|Verifying|Already exists)|Digest:\s|Status:\s+Downloaded)/i;
// Service state-change lines: `Creating <svc> ...`, `Starting <svc> ...`,
// `Stopping <svc> ...`, `<svc> exited with code N`, `Attaching to ...`.
const COMPOSE_STATE_RE =
  /^(Creating|Starting|Stopping|Removing|Attaching to|Gracefully stopping|.*exited with code\s+\d+)/;
// Service ERROR lines (often `<svc>  | [ERROR] ...` or `ERROR: ...`).
const COMPOSE_ERROR_RE = /(\[ERROR\]|^ERROR:|exited with code\s+[1-9])/i;
// Network/volume creation — low-signal setup noise.
const COMPOSE_SETUP_RE = /^Creating (network|volume)\b/i;

// ─── shared ─────────────────────────────────────────────────────────────────

// Detect which docker subcommand produced the output, so we route to the
// right compression strategy. Returns "ps" | "build" | "compose" | null.
function detectMode(raw: string): "ps" | "build" | "compose" | null {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  if (PS_HEADER_RE.test(firstLine)) return "ps";
  // build: presence of Step N/N lines anywhere in the first chunk
  if (BUILD_STEP_RE.test(firstLine) || /Step\s+\d+\/\d+\s*:/.test(raw)) {
    return "build";
  }
  // compose: pull/state-change lines
  if (
    COMPOSE_PULL_RE.test(firstLine) ||
    COMPOSE_STATE_RE.test(firstLine) ||
    COMPOSE_SETUP_RE.test(firstLine) ||
    /Attaching to\s+\S/.test(raw)
  ) {
    return "compose";
  }
  return null;
}

// Compress `docker ps -a` table output.
function compressPs(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length < 8) return raw; // small table — not worth it

  const header = lines[0]!;
  const rows = lines.slice(1);

  const healthy: string[] = [];
  const anomalies: string[] = [];

  for (const row of rows) {
    if (PS_ANOMALY_RE.test(row)) {
      anomalies.push(row);
    } else if (PS_HEALTHY_RE.test(row)) {
      healthy.push(row);
    } else {
      // Unknown row — treat as anomaly (safer to surface).
      anomalies.push(row);
    }
  }

  // If everything is healthy and few rows, table is already compact.
  if (anomalies.length === 0 && rows.length < 15) return raw;

  const out: string[] = [header];
  out.push(
    `(${healthy.length} running, ${anomalies.length} need attention)`,
  );

  if (anomalies.length > 0) {
    out.push("");
    out.push("needs attention:");
    out.push(...anomalies.slice(0, PS_MAX_ROWS));
    if (anomalies.length > PS_MAX_ROWS) {
      out.push(`... +${anomalies.length - PS_MAX_ROWS} more`);
    }
  }

  const result = out.join("\n");
  if (result.length >= raw.length) return raw;
  return result;
}

// Compress `docker build` output.
function compressBuild(raw: string): string {
  const lines = raw.split("\n");

  const summary: string[] = [];
  const errors: string[] = [];
  let noiseDropped = 0;

  for (const line of lines) {
    if (BUILD_SUMMARY_RE.test(line)) {
      summary.push(line.trim());
      continue;
    }
    if (BUILD_ERROR_RE.test(line)) {
      errors.push(line.trim());
      continue;
    }
    if (
      BUILD_STEP_RE.test(line) ||
      BUILD_HASH_RE.test(line) ||
      BUILD_INTERMEDIATE_RE.test(line)
    ) {
      noiseDropped++;
      continue;
    }
    // Blank lines — drop.
    if (line.trim() === "") continue;
    // Unknown line — drop (build output is highly structured; unknowns
    // are usually nested RUN output that's already summarised by the
    // summary line or surfaced as an error).
    noiseDropped++;
  }

  // If we found nothing meaningful, return raw.
  if (summary.length === 0 && errors.length === 0) return raw;

  const out: string[] = [];
  if (summary.length > 0) {
    out.push(summary.join("; "));
  }
  if (errors.length > 0) {
    out.push("");
    out.push(`${errors.length} error(s)/warning(s):`);
    out.push(...errors.slice(0, 20));
    if (errors.length > 20) out.push(`... +${errors.length - 20} more`);
  }
  if (noiseDropped > 0) {
    out.push(`(${noiseDropped} step/hash lines dropped)`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}

// Compress `docker compose up` output.
function compressCompose(raw: string): string {
  const lines = raw.split("\n");

  const states: string[] = [];
  const errors: string[] = [];
  let noiseDropped = 0;

  for (const line of lines) {
    // Service state changes — keep.
    if (COMPOSE_STATE_RE.test(line) && !COMPOSE_SETUP_RE.test(line)) {
      states.push(line.trim());
      continue;
    }
    // Error lines — keep.
    if (COMPOSE_ERROR_RE.test(line)) {
      errors.push(line.trim());
      continue;
    }
    // Pull noise — drop.
    if (COMPOSE_PULL_RE.test(line) || COMPOSE_SETUP_RE.test(line)) {
      noiseDropped++;
      continue;
    }
    // Blank lines — drop.
    if (line.trim() === "") continue;
    // Unknown line — drop (compose log spam is huge; unknowns are almost
    // always per-service INFO/DEBUG log lines).
    noiseDropped++;
  }

  // If we found nothing meaningful, return raw.
  if (states.length === 0 && errors.length === 0) return raw;

  const out: string[] = [];
  if (states.length > 0) {
    out.push(`${states.length} service state change(s):`);
    out.push(...states.slice(0, 20));
    if (states.length > 20) out.push(`... +${states.length - 20} more`);
  }
  if (errors.length > 0) {
    out.push("");
    out.push(`${errors.length} error(s):`);
    out.push(...errors.slice(0, 20));
    if (errors.length > 20) out.push(`... +${errors.length - 20} more`);
  }
  if (noiseDropped > 0) {
    out.push(`(${noiseDropped} pull/log lines dropped)`);
  }

  const result = out.join("\n").trim();
  if (!result || result.length >= raw.length) return raw;
  return result;
}

export const dockerCompressor: Compressor = {
  name: "docker",
  category: "infra",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `docker ps` (with optional -a/--format flags)
    if (/^docker\s+ps\b/.test(cmd)) {
      // Exclude --format that produces non-table output (json/go-template).
      if (/\s--format\s+['"]?\{/.test(cmd)) return false;
      return true;
    }
    // `docker build` / `docker image build`
    if (/^docker\s+(image\s+)?build\b/.test(cmd)) return true;
    // `docker compose up` / `docker-compose up`
    if (/^docker(-|\s)compose\s+up\b/.test(cmd)) return true;
    return false;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const mode = detectMode(raw);
    if (mode === "ps") return compressPs(raw);
    if (mode === "build") return compressBuild(raw);
    if (mode === "compose") return compressCompose(raw);
    return raw;
  },
};
