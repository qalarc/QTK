// `kubectl get` table-output compressor.
//
// `kubectl get pods` (and other resources) prints a table:
//   NAME                 READY   STATUS    RESTARTS   AGE
//   foo-abc              1/1     Running   0          5m
//   bar-def              1/1     Running   0          12m
//   baz-ghi              0/1     Pending   0          1m
//   ...50 more rows...
//
// For the model, a wall of `Running 0 5m` rows is noise. What matters:
//   - The header (column meaning)
//   - Count by status (how many Running vs Pending vs Failed)
//   - Any non-Running / not-Ready rows (those need attention)
//
// Strategy: keep header + summary + anomalous rows, drop healthy rows.
// Falls back to raw if the table is too small or doesn't look like kubectl.

import type { Compressor } from "../types.ts";

// kubectl table header detection. The first column is usually NAME (or a
// prefix like NAMESPACE). Common headers: READY, STATUS, RESTARTS, AGE.
const HEADER_RE =
  /^(NAME|NAMESPACE)\s+.*\b(STATUS|STATE|READY|PHASE|RESTARTS|AGE)\b/;

// A row that is fully healthy: ends with "Running   0" (status Running,
// restarts 0). We treat these as noise to summarise.
// Matches: "name  1/1  Running  0  5m"  (STATUS=Running, RESTARTS=0)
const HEALTHY_RE = /\bRunning\b\s+\d+\s+\d/;

// Anomalous statuses that the model needs to see.
const ANOMALY_RE =
  /\b(Pending|Failed|CrashLoopBackOff|ImagePullBackOff|Error|Evicted|Terminating|Unknown|OOMKilled|Completed|ContainerCreating)\b/;

// Not-ready: READY column shows "0/N".
const NOT_READY_RE = /\b0\/\d+\b/;

const MAX_ROWS_SHOWN = 20;

export const kubectlCompressor: Compressor = {
  name: "kubectl",
  category: "infra",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // Match `kubectl get <resource>` but NOT `-o yaml`/`-o json` (those go
    // to the sidecar YAML/JSON pruner).
    if (!/^kubectl\s+get\s+\S/.test(cmd)) return false;
    if (/\s-o\s*(yaml|json|jsonpath|go-template|name|custom-columns)\b/.test(cmd)) {
      return false;
    }
    return true;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length < 8) return raw; // small table — not worth compressing

    // First non-empty line must look like a kubectl header.
    if (!HEADER_RE.test(lines[0]!)) return raw;

    const header = lines[0]!;
    const rows = lines.slice(1);

    const healthy: string[] = [];
    const anomalies: string[] = [];

    for (const row of rows) {
      if (ANOMALY_RE.test(row) || NOT_READY_RE.test(row)) {
        anomalies.push(row);
      } else if (HEALTHY_RE.test(row)) {
        healthy.push(row);
      } else {
        // Unknown row — treat as anomaly (safer to surface it).
        anomalies.push(row);
      }
    }

    // If everything is healthy and there are few rows, the table is already
    // compact — don't compress.
    if (anomalies.length === 0 && rows.length < 15) return raw;

    const out: string[] = [header];
    out.push(`(${healthy.length} healthy, ${anomalies.length} need attention)`);

    if (anomalies.length > 0) {
      out.push("");
      out.push("needs attention:");
      out.push(...anomalies.slice(0, MAX_ROWS_SHOWN));
      if (anomalies.length > MAX_ROWS_SHOWN) {
        out.push(`... +${anomalies.length - MAX_ROWS_SHOWN} more`);
      }
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};
