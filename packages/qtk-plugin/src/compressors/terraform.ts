// `terraform plan` / `terraform apply` compressor.
//
// Terraform plan/apply output has two phases:
//   1. Refresh phase: `aws_instance.web: Refreshing state... [id=...]` and
//      `data.aws_ami.ubuntu: Reading...` / `Read complete after Ns`. On a real
//      stack with 50+ resources this is the BULK of the output (often 80%+)
//      and is pure noise — it's terraform reconciling its state cache, not the
//      proposed changes.
//   2. Plan phase: the actual diff. Resource action markers (`# <res> will be
//      created/destroyed/updated/replaced`) followed by the `+`/`-`/`~`/`-/+`
//      diff lines showing exactly what changes. This is the high-value content.
//
// The signal lives in:
//   - Resource action markers: `# aws_instance.web will be created` etc.
//   - The diff lines: `+ attr` (new), `- attr` (removed), `~ attr -> newval`
//     (changed), `-/+` (force-replace). These ARE the plan.
//   - The `Plan: N to add, M to change, K to destroy.` summary.
//   - The `Changes to Outputs:` block (output diffs).
//   - `Apply complete! Resources: N added, M changed, K destroyed.` (apply).
//   - `Error:` lines (plan/apply failures).
//
// Strategy: keep the diff lines (`+`/`-`/`~`/`-/+` prefixed), resource action
// markers, the Plan/Apply summary, the Changes to Outputs block, and errors;
// drop the refresh-phase noise (`Refreshing state...`, `data.*: Reading`/
// `Read complete`), the `Terraform used the selected providers...` preamble,
// the decorative `─` borders, and the `Saved the plan to:` / `To perform
// exactly these actions` epilogue.
//
// This compressor is LOSSY: it drops the refresh-phase noise, the provider
// preamble, decorative borders, and the plan-file epilogue. It is NOT
// reversible. The actual diff (the `+`/`-`/`~` lines), resource action markers,
// and the Plan/Apply summary are preserved verbatim — which is the entire
// point of a plan/apply output.

import type { Compressor } from "../types.ts";

// `aws_instance.web: Refreshing state... [id=...]` — refresh phase. Drop.
const REFRESH_RE = /^[\w.]+:\s+Refreshing state\.\.\./;

// `data.aws_ami.ubuntu: Reading...` / `data.*: Read complete after Ns`. Drop.
const DATA_READ_RE = /^data\.[\w.]+:\s+(Reading\.\.\.|Read complete)/;

// `# aws_instance.web will be created` / `destroyed` / `updated in-place` /
// `replaced` — resource action marker. Keep.
const ACTION_MARKER_RE =
  /^\s*#\s+[\w.]+\s+will be\s+(created|destroyed|updated|replaced)/;

// Diff lines: `  + attr`, `  - attr`, `  ~ attr`, `  -/+ resource`. Keep.
// These start with optional indent then a diff symbol. We match the leading
// `+`/`-`/`~`/`-/+` after optional whitespace, but NOT `->` (which is a value
// arrow inside a diff line, handled by the `~` parent). The `-/+` is the
// force-replace marker.
const DIFF_RE = /^\s+(\+|-|~|-\/\+|\*|->)/;

// `Plan: N to add, M to change, K to destroy.` — plan summary. Keep.
const PLAN_SUMMARY_RE = /^Plan:\s+\d+\s+to\s+(add|change|destroy)/;

// `Apply complete! Resources: N added, M changed, K destroyed.` — apply. Keep.
const APPLY_COMPLETE_RE = /^Apply complete!/;

// `Changes to Outputs:` — start of the outputs diff block. Keep.
const CHANGES_TO_OUTPUTS_RE = /^Changes to Outputs:/;

// `Error:` / `╷` / `╵` — terraform error block. Keep Error: lines; the
// decorative `╷`/`╵` borders are dropped (see BORDER_RE).
const ERROR_RE = /^Error:/;

// `Terraform used the selected providers to generate the following execution
// plan.` — preamble. Drop.
const PREAMBLE_RE = /^Terraform used the selected providers/;

// `Resource actions are indicated with the following symbols:` + the legend
// lines (`  + create`, `  ~ update in-place`). Drop.
const SYMBOLS_HEADER_RE = /^Resource actions are indicated/;
const SYMBOL_LEGEND_RE = /^\s+(\+|-|~|-\/\+)\s+(create|destroy|update|replace)/;

// `Terraform will perform the following actions:` — header before the diff.
// Drop (the action markers that follow are self-describing).
const WILL_PERFORM_RE = /^Terraform will perform the following actions:/;

// `Saved the plan to: tfplan` / `To perform exactly these actions...` epilogue.
// Drop.
const SAVED_PLAN_RE = /^Saved the plan to:/;
const APPLY_HINT_RE = /^To perform exactly these actions/;

// `terraform apply "tfplan"` indented command hint. Drop.
const APPLY_CMD_RE = /^\s+terraform apply /;

// Decorative border: a line of `─` (box-drawing horizontal). Drop.
const BORDER_RE = /^[\s─]+$/;

// `resource "type" "name" {` — the opening brace of a resource block in the
// diff. Keep (it's part of the diff structure under an action marker).
const RESOURCE_OPEN_RE = /^\s+resource\s+"/;

export const terraformCompressor: Compressor = {
  name: "terraform",
  category: "infra",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><]/.test(cmd)) return false;
    // `terraform plan`, `terraform apply`, `terraform apply -auto-approve`,
    // `terraform apply tfplan`. Exclude `terraform init` (download noise,
    // different shape), `terraform fmt`, `terraform validate`.
    return /^terraform\s+(plan|apply)(\s|$)/.test(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200) return raw;

    const lines = raw.split("\n");

    const kept: string[] = [];
    let noiseDropped = 0;
    // State flags:
    //   - inOutputs: inside the `Changes to Outputs:` block — keep the diff
    //     lines (they use the same `+`/`-`/`~` prefix).
    //   - inDiff: inside a resource diff block (after an action marker) — keep
    //     the `+`/`-`/`~` lines and the `resource "..." {` opener.
    let inOutputs = false;
    let inDiff = false;

    for (const line of lines) {
      // Plan summary — always keep, ends diff/output blocks.
      if (PLAN_SUMMARY_RE.test(line)) {
        kept.push(line.trim());
        inDiff = false;
        inOutputs = false;
        continue;
      }
      // Apply complete — always keep.
      if (APPLY_COMPLETE_RE.test(line)) {
        kept.push(line.trim());
        inDiff = false;
        inOutputs = false;
        continue;
      }
      // Error — always keep.
      if (ERROR_RE.test(line)) {
        kept.push(line.trim());
        inDiff = false;
        inOutputs = false;
        continue;
      }
      // Changes to Outputs — keep marker, enter block.
      if (CHANGES_TO_OUTPUTS_RE.test(line)) {
        kept.push(line.trim());
        inOutputs = true;
        inDiff = false;
        continue;
      }
      // Resource action marker — keep, enter diff block.
      if (ACTION_MARKER_RE.test(line)) {
        kept.push(line.trim());
        inDiff = true;
        inOutputs = false;
        continue;
      }
      // Diff line (`+`/`-`/`~`/`-/+` prefixed) — keep (works in both diff and
      // outputs blocks).
      if (DIFF_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // `resource "type" "name" {` opener inside a diff block — keep.
      if (inDiff && RESOURCE_OPEN_RE.test(line)) {
        kept.push(line);
        continue;
      }
      // Inside outputs block: keep `  ~ output = ...` style lines (already
      // caught by DIFF_RE above) and the closing `}`. A bare `}` under outputs
      // is structural — keep it.
      if (inOutputs && line.trim() === "}") {
        kept.push(line);
        continue;
      }
      // Inside a diff block: a bare `}` closes the resource block. Keep it
      // (structural — completes the resource diff).
      if (inDiff && line.trim() === "}") {
        kept.push(line);
        inDiff = false;
        continue;
      }
      // Refresh noise — drop.
      if (REFRESH_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Data read noise — drop.
      if (DATA_READ_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Preamble — drop.
      if (PREAMBLE_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Symbols header + legend — drop.
      if (SYMBOLS_HEADER_RE.test(line) || SYMBOL_LEGEND_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // "Terraform will perform the following actions:" — drop.
      if (WILL_PERFORM_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Saved plan / apply hint epilogue — drop.
      if (SAVED_PLAN_RE.test(line) || APPLY_HINT_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      if (APPLY_CMD_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Decorative border — drop.
      if (BORDER_RE.test(line)) {
        noiseDropped++;
        continue;
      }
      // Blank lines — drop (reset diff/output state on blank to be safe).
      if (line.trim() === "") {
        // A blank line inside a diff block doesn't end it (terraform puts
        // blanks between attributes), but a blank after a `}` does. We already
        // exit inDiff on `}`. Keep it simple: don't reset on blank.
        continue;
      }
      // Unknown line — keep defensively if it looks like an error/warning.
      if (/\b(error|warning|failed|deprecated)\b/i.test(line)) {
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
