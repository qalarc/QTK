// `go vet` compressor.
//
// NOTE: this compressor targets `go vet` / `go tool vet` SPECIFICALLY. It is
// distinct from the `go` compressor, which handles `go test` / `go build`
// (test-runner + build output). `go vet` emits a different, more uniform
// output shape — structured per-file findings tagged with a checker name —
// and benefits from a dedicated compressor that drops the `# package/path`
// section headers (noise) and keeps only the findings.
//
// `go vet` output looks like:
//
//   go version go1.22.5 linux/amd64
//   # example.com/myproject/internal/handler
//   ./handler.go:42:6: composites: example.com/myproject/pkg.Config composite literal uses unkeyed fields
//   ./handler.go:58:15: printf: fmt.Printf format %d reads arg #1, but call has 2 args
//   # example.com/myproject/internal/service
//   ./service.go:15:2: structtag: unknown field tag `jsom` for struct field `Name`
//   ./service.go:22:6: lostcancel: the cancel function returned by context.WithCancel should be called
//   exit status 3
//
// The signal lives in:
//   - The `file.go:LINE:COL: <checker>: <message>` finding lines. The checker
//     name (printf, composites, structtag, lostcancel, shadow, unreachable,
//     errorsas, assign, stringintconv, ...) + the message + the location are
//     all actionable.
//   - The `exit status N` line (vet exits non-zero when it finds issues).
//
// The bulk that CAN be compressed:
//   - The version banner (`go version go1.22.5 ...`).
//   - The `# package/path` section headers (vet prints one per package; the
//     package is derivable from the finding's file path).
//   - Progress chatter.
//
// Strategy: keep finding lines + the `exit status N` line; drop the version
// banner and the `# package/path` headers. This mirrors the ruff/eslint
// pattern (lint findings with codes — drop the grouping noise).
//
// This compressor is LOSSY: it drops the version banner and the `# package`
// section headers. It is NOT reversible. Every finding (checker + message +
// file + line + col) is preserved.

import type { Compressor } from "../types.ts";

// Finding line: `./file.go:LINE:COL: <checker>: <message>` or
// `file.go:LINE: <checker>: <message>` (no column). The checker name is a
// lowercase identifier. Keep.
// We anchor on the `file.go:NUM[:NUM]: <word>:` prefix.
const FINDING_RE = /^(\.\/)?[\w./-]+\.go:\d+(?::\d+)?:\s+\w+:/;

// `exit status N` — vet's non-zero exit marker. Keep.
const EXIT_RE = /^exit status \d+/;

// Version banner: `go version go1.22.5 linux/amd64`. Drop.
const VERSION_RE = /^go version go\d/;

// Package section header: `# example.com/myproject/internal/handler`. Drop.
// (The package path is derivable from the finding's file path.)
const PKG_HEADER_RE = /^#\s+\S/;

export const goVetCompressor: Compressor = {
  name: "go-vet",
  category: "linter",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `go vet ./...`, `go vet .`, `go tool vet ./pkg`, `go vet -composites ./...`.
    // EXCLUDE `go vet -h` / `go vet -help` (help text, not a vet run).
    if (/^go\s+vet\s+-h/.test(cmd)) return false;
    if (/^go\s+vet\s+--help/.test(cmd)) return false;
    return /^go\s+(vet|tool\s+vet)\b/.test(cmd);
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
      // `exit status N` — keep.
      if (EXIT_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (VERSION_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Package section header — drop.
      if (PKG_HEADER_RE.test(line)) {
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
