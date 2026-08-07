// `golangci-lint` compressor.
//
// NOTE: this compressor targets `golangci-lint run` (the Go meta-linter),
// NOT `go vet` (which is handled by the dedicated `go-vet` compressor).
// golangci-lint wraps multiple linters (staticcheck, gosimple, govet,
// errcheck, ineffassign, unused, revive, gocyclo, ...) and tags each finding
// with the linter name. `go vet` emits a subset of these (the vet suite only)
// without the `<linter>:` tag. This compressor matches ONLY the
// `golangci-lint` command; `go vet` matches `go vet` / `go tool vet`.
//
// golangci-lint output looks like:
//
//   level=info msg="[config] golangci-lint config file found: .golangci.yml"
//   level=info msg="[lintersdb] Active 10 linters and 0 linters configurations"
//   level=info msg="[runner] worker 1 allocated (1 workers)"
//   level=info msg="[runner] worker 2 allocated (2 workers)"
//   main.go:15:6: S1000: should use a simple channel iteration
//   (staticcheck)
//   main.go:23:2: G104: Errors unhandled. (errcheck)
//   main.go:31:10: S1024: should replace time.Now().Sub(t) with time.Since(t)
//   (staticcheck)
//   main.go:42:5: ineffectual assignment to err (ineffassign)
//   handler.go:10:18: Error return value of `w.Write` is not checked (errcheck)
//   handler.go:25:6: func `process` has too many statements (35 > 30)
//   (gocyclo)
//   handler.go:40:11: G601: Implicit memory aliasing in for loop.
//   (govet)
//   service.go:12:2: `config` is unused (unused)
//   service.go:18:6: should replace magic number 86400 with constant (gomnd)
//
//   level=warning msg="[linters] this linter is deprecated"
//   level=error msg="[runner] Panic: ..."
//
//   8 issues:
//   (8 errors, 0 warnings)
//
// Or with the default text format and a summary:
//
//   main.go:15:6: S1000: should use a simple channel iteration (staticcheck)
//   main.go:23:2: G104: Errors unhandled. (errcheck)
//   handler.go:10:18: Error return value of `w.Write` is not checked (errcheck)
//   3 issues found.
//
// The signal lives in:
//   - The `file.go:LINE:COL: <code>: msg (<linter>)` finding lines. The linter
//     name (in trailing parens) + the rule code (S1000, G104, G601, ...) + the
//     message + the location are all actionable.
//   - The `file.go:LINE:COL: msg (<linter>)` finding lines (no rule code —
//     some linters like ineffassign, gocyclo, unused don't emit a code).
//   - The `level=error` / `level=warning` markers when present (these carry
//     linter-runner errors and deprecation notices).
//   - The `N issues found.` / `N issues:` summary.
//
// The bulk that CAN be compressed:
//   - The version banner (`golangci-lint has version 1.59.1`).
//   - The `level=info` chatter (`[config]`, `[lintersdb]`, `[runner] worker N
//     allocated`, `[linters] Active N linters`).
//   - The `Running [linters]...` / `Running ...` progress lines.
//   - The decorative blank-line separators between findings.
//   - The continuation line that is JUST the linter name in parens on its own
//     line (golangci-lint sometimes wraps the `(<linter>)` tag onto the next
//     line for long messages).
//
// Strategy: keep finding lines, `level=error`/`level=warning` markers, and the
// `N issues` summary; drop the version banner, `level=info` chatter, progress
// lines, and decorative separators. This mirrors the go-vet/ruff pattern (lint
// findings with codes — drop the runner chatter).
//
// This compressor is LOSSY: it drops the version banner, `level=info` chatter,
// and progress lines. It is NOT reversible. Every finding (linter + code +
// message + file + line + col) and the issue summary are preserved.

import type { Compressor } from "../types.ts";

// Finding line: `file.go:LINE:COL: <code>: msg (<linter>)` or
// `file.go:LINE:COL: msg (<linter>)` (no code) or
// `file.go:LINE:COL: <code>: msg` (linter tag wrapped to next line).
// The linter name may be a trailing `(<word>)` OR on the following line.
// Keep.
// We anchor on `path.go:NUM:NUM:` + some content. The trailing `(<linter>)`
// is optional (golangci-lint wraps it onto the next line for long messages).
const FINDING_RE = /^(\.\/)?[\w./-]+\.go:\d+:\d+:\s+.+/;

// Continuation line: just `(<linter>)` on its own line (golangci-lint wraps
// the linter tag onto the next line for long messages). Keep — it completes
// the preceding finding.
const LINTER_TAG_CONT_RE = /^\(\w+\)$/;

// `level=error` / `level=warning` — runner errors + deprecation notices. Keep.
const LEVEL_WARN_ERROR_RE = /^level=(error|warning)\b/;

// Summary: `N issues found.` / `N issues:` / `(N errors, M warnings)`. Keep.
const SUMMARY_RE = /^(\d+\s+issues?\s*(found|:|\(|$)|\(\d+\s+errors?,\s+\d+\s+warnings?\))/;

// `level=info` chatter. Drop.
const LEVEL_INFO_RE = /^level=info\b/;

// Version banner: `golangci-lint has version 1.59.1`. Drop.
const VERSION_RE = /^golangci-lint has version\b/;

// `Running [linters]...` / `Running <linter>...` progress. Drop.
const RUNNING_RE = /^Running\s+/;

export const golangciLintCompressor: Compressor = {
  name: "golangci-lint",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `golangci-lint run`, `golangci-lint run ./...`, `golangci-lint run -E
    // staticcheck`. EXCLUDE `golangci-lint --version` / `golangci-lint version`
    // (version info, not a lint run), `golangci-lint linters` (lists linters),
    // `golangci-lint config` (config management), `golangci-lint cache`
    // (cache management), `golangci-lint help`.
    if (/golangci-lint\s+--?version\b/.test(cmd)) return false;
    if (/golangci-lint\s+version\b/.test(cmd)) return false;
    if (/golangci-lint\s+linters\b/.test(cmd)) return false;
    if (/golangci-lint\s+config\b/.test(cmd)) return false;
    if (/golangci-lint\s+cache\b/.test(cmd)) return false;
    if (/golangci-lint\s+help\b/.test(cmd)) return false;
    // Match `golangci-lint run` (the lint subcommand) OR bare
    // `golangci-lint` (defaults to `run`). Distinguish from `go vet` (which
    // the go-vet compressor handles — that matches `go vet`, not
    // `golangci-lint`).
    return /(^|\s)golangci-lint(\s+run)?(\s|$)/.test(cmd);
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
      // Continuation linter tag `(<linter>)` — keep (completes prev finding).
      if (LINTER_TAG_CONT_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `level=error` / `level=warning` — keep.
      if (LEVEL_WARN_ERROR_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Summary — keep.
      if (SUMMARY_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `level=info` chatter — drop.
      if (LEVEL_INFO_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // `Running [linters]...` progress — drop.
      if (RUNNING_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop.
      if (line.trim() === "") {
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/failure.
      if (/\b(error|failed|panic)\b/i.test(line)) {
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
