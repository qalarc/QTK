// Tests for the helm compressor.
//
// Covers:
//   1. matches helm install / upgrade / rollback (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match helm template (rendered YAML is the intended output)
//   4. does NOT match helm version / list / repo
//   5. does NOT match non-bash tools
//   6. compresses install output by >= 10%
//   7. keeps the release status block (NAME/LAST DEPLOYED/NAMESPACE/STATUS/REVISION)
//   8. keeps the NOTES: section content
//   9. keeps Error: lines
//  10. keeps coalesce.go: warning: template errors
//  11. keeps Warning: hook-failure lines
//  12. drops Creating/Deleting/Wiping/Building/Updating progress noise
//  13. tiny input passes through
//  14. garbage input passes through
//  15. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { helmCompressor } from "../src/compressors/helm.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("helm compressor", () => {
  test("matches helm install / upgrade / rollback", () => {
    expect(
      helmCompressor.matches("bash", { command: "helm install my-app ./chart" }),
    ).toBe(true);
    expect(
      helmCompressor.matches("bash", {
        command: "helm upgrade my-app ./chart -f values.yaml",
      }),
    ).toBe(true);
    expect(
      helmCompressor.matches("bash", { command: "helm rollback my-app 2" }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      helmCompressor.matches("bash", {
        command: "helm install my-app ./chart | grep NAME",
      }),
    ).toBe(false);
    expect(
      helmCompressor.matches("bash", {
        command: "helm upgrade my-app ./chart && echo done",
      }),
    ).toBe(false);
  });

  test("does NOT match helm template (rendered YAML is the intended output)", () => {
    expect(
      helmCompressor.matches("bash", { command: "helm template my-app ./chart" }),
    ).toBe(false);
  });

  test("does NOT match helm version / list / repo", () => {
    expect(
      helmCompressor.matches("bash", { command: "helm version" }),
    ).toBe(false);
    expect(
      helmCompressor.matches("bash", { command: "helm list" }),
    ).toBe(false);
    expect(
      helmCompressor.matches("bash", { command: "helm repo add stable ..." }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      helmCompressor.matches("read", { command: "helm install my-app ./chart" }),
    ).toBe(false);
  });

  test("compresses install output by >= 10%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.9); // at least 10% reduction
  });

  test("keeps the release status block", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).toContain("NAME: my-app");
    expect(out).toContain("LAST DEPLOYED:");
    expect(out).toContain("NAMESPACE: production");
    expect(out).toContain("STATUS: deployed");
    expect(out).toContain("REVISION: 3");
  });

  test("keeps the NOTES: section content", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).toContain("NOTES:");
    expect(out).toContain("1. Get the application URL by running these commands:");
    expect(out).toContain("kubectl --namespace production port-forward");
  });

  test("keeps Error: lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).toContain("Error: Kubernetes cluster unreachable: connection refused");
  });

  test("keeps coalesce.go: warning: template errors", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).toContain(
      "coalesce.go: warning: destination for annotations is a table. Ignoring non-table value",
    );
    expect(out).toContain(
      "coalesce.go: warning: cannot overwrite table with non-table for annotations",
    );
  });

  test("keeps Warning: hook-failure lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).toContain(
      "Warning: Hook pre-install my-app/templates/hooks/pre-install-job.yaml failed",
    );
  });

  test("drops Creating/Deleting/Wiping/Building/Updating progress noise", async () => {
    const input = await Bun.file(
      new URL("./fixtures/helm/install.input.txt", import.meta.url),
    ).text();
    const out = helmCompressor.compress(input, CTX);
    expect(out).not.toContain("Creating my-app");
    expect(out).not.toContain("Wiping old release data");
    expect(out).not.toContain("Building dependency tree");
    expect(out).not.toContain("Updating dependencies");
  });

  test("tiny input passes through unchanged", () => {
    const input = "NAME: x\nSTATUS: deployed\n";
    expect(helmCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not helm output\nat all\nnothing useful here\n".repeat(20);
    expect(helmCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k progress lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`Creating release-${i}`);
    }
    lines.push("NAME: my-app");
    lines.push("STATUS: deployed");
    lines.push("REVISION: 1");
    const input = lines.join("\n");
    const t0 = performance.now();
    helmCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
