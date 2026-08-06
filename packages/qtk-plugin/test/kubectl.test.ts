// Tests for the kubectl get table-output compressor.
//
// Covers:
//   1. matches `kubectl get <resource>`
//   2. does NOT match `-o yaml/json` (those go to the sidecar)
//   3. does NOT match piped/compound or non-get kubectl commands
//   4. compresses a large pods table — keeps header + summary + anomalies
//   5. drops healthy Running rows
//   6. surfaces anomalous statuses (Pending, CrashLoopBackOff, etc.)
//   7. small table passes through unchanged
//   8. tiny input passes through
//   9. garbage input passes through
//  10. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { kubectlCompressor } from "../src/compressors/kubectl.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("kubectl compressor", () => {
  test("matches kubectl get <resource>", () => {
    expect(kubectlCompressor.matches("bash", { command: "kubectl get pods" })).toBe(
      true,
    );
    expect(
      kubectlCompressor.matches("bash", { command: "kubectl get deploy" }),
    ).toBe(true);
    expect(
      kubectlCompressor.matches("bash", { command: "kubectl get svc -A" }),
    ).toBe(true);
  });

  test("does NOT match -o yaml/json (sidecar handles those)", () => {
    expect(
      kubectlCompressor.matches("bash", {
        command: "kubectl get pods -o yaml",
      }),
    ).toBe(false);
    expect(
      kubectlCompressor.matches("bash", {
        command: "kubectl get pods -o json",
      }),
    ).toBe(false);
    expect(
      kubectlCompressor.matches("bash", {
        command: "kubectl get pods -o name",
      }),
    ).toBe(false);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      kubectlCompressor.matches("bash", { command: "kubectl get pods | grep foo" }),
    ).toBe(false);
    expect(
      kubectlCompressor.matches("bash", { command: "kubectl get pods && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match non-get kubectl commands", () => {
    expect(
      kubectlCompressor.matches("bash", { command: "kubectl describe pod foo" }),
    ).toBe(false);
    expect(kubectlCompressor.matches("bash", { command: "kubectl logs foo" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(kubectlCompressor.matches("read", { command: "kubectl get pods" })).toBe(
      false,
    );
  });

  test("compresses a large pods table by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/kubectl/pods.input.txt", import.meta.url),
    ).text();
    const out = kubectlCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
    // Header preserved
    expect(out).toContain("NAME");
    expect(out).toContain("STATUS");
    // Summary line
    expect(out).toContain("healthy");
    expect(out).toContain("need attention");
    // Anomalous pods surfaced
    expect(out).toContain("CrashLoopBackOff");
    expect(out).toContain("ImagePullBackOff");
    expect(out).toContain("OOMKilled");
    expect(out).toContain("Pending");
    // Healthy rows dropped (not all of them)
    expect(out).not.toContain("api-server-5644f5b6c7-abc12");
  });

  test("all-healthy large table still compresses to summary", () => {
    const lines: string[] = ["NAME             READY   STATUS    RESTARTS   AGE"];
    for (let i = 0; i < 30; i++) {
      lines.push(`pod-${i}-abc123def   1/1     Running   0          ${i}m`);
    }
    const input = lines.join("\n");
    const out = kubectlCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("30 healthy");
    expect(out).toContain("0 need attention");
  });

  test("small table passes through unchanged", () => {
    const input = [
      "NAME          READY   STATUS    RESTARTS   AGE",
      "pod-a         1/1     Running   0          5m",
      "pod-b         1/1     Running   0          3m",
    ].join("\n");
    expect(kubectlCompressor.compress(input, CTX)).toBe(input);
  });

  test("tiny input passes through unchanged", () => {
    const input = "No resources found.";
    expect(kubectlCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not kubectl output\nat all\nnothing here\n".repeat(20);
    expect(kubectlCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k rows)", () => {
    const lines: string[] = ["NAME             READY   STATUS    RESTARTS   AGE"];
    for (let i = 0; i < 10000; i++) {
      lines.push(`pod-${i}-xyz789abc   1/1     Running   0          ${i}m`);
    }
    const input = lines.join("\n");
    const t0 = performance.now();
    kubectlCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
