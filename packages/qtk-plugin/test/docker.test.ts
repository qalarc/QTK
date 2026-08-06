// Tests for the docker ps / docker build / docker compose up compressor.
//
// Covers:
//   1. matches docker ps / build / compose up (and variants)
//   2. does NOT match piped/compound or unrelated docker commands
//   3. does NOT match --format json (non-table output)
//   4. compresses docker ps -a table — keeps header + summary + anomalies
//   5. drops healthy Up rows
//   6. surfaces anomalous statuses (Exited, Restarting, unhealthy)
//   7. compresses docker build — keeps Successfully built/tagged + errors
//   8. drops Step N/N + hash + intermediate noise
//   9. compresses docker compose up — keeps state changes + errors
//  10. drops pull noise + generic log spam
//  11. tiny input passes through
//  12. garbage input passes through
//  13. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { dockerCompressor } from "../src/compressors/docker.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("docker compressor", () => {
  test("matches docker ps variants", () => {
    expect(dockerCompressor.matches("bash", { command: "docker ps" })).toBe(
      true,
    );
    expect(dockerCompressor.matches("bash", { command: "docker ps -a" })).toBe(
      true,
    );
    expect(
      dockerCompressor.matches("bash", { command: "docker ps --all" }),
    ).toBe(true);
  });

  test("matches docker build and compose up", () => {
    expect(dockerCompressor.matches("bash", { command: "docker build ." })).toBe(
      true,
    );
    expect(
      dockerCompressor.matches("bash", { command: "docker build -t foo ." }),
    ).toBe(true);
    expect(
      dockerCompressor.matches("bash", { command: "docker image build ." }),
    ).toBe(true);
    expect(
      dockerCompressor.matches("bash", { command: "docker compose up" }),
    ).toBe(true);
    expect(
      dockerCompressor.matches("bash", { command: "docker compose up -d" }),
    ).toBe(true);
    expect(
      dockerCompressor.matches("bash", { command: "docker-compose up" }),
    ).toBe(true);
  });

  test("does NOT match --format with json template (non-table output)", () => {
    expect(
      dockerCompressor.matches("bash", {
        command: "docker ps --format '{{json .}}'",
      }),
    ).toBe(false);
    expect(
      dockerCompressor.matches("bash", {
        command: 'docker ps --format "{{json .}}"',
      }),
    ).toBe(false);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      dockerCompressor.matches("bash", { command: "docker ps | grep foo" }),
    ).toBe(false);
    expect(
      dockerCompressor.matches("bash", { command: "docker ps && echo ok" }),
    ).toBe(false);
  });

  test("does NOT match unrelated docker commands", () => {
    expect(
      dockerCompressor.matches("bash", { command: "docker logs foo" }),
    ).toBe(false);
    expect(
      dockerCompressor.matches("bash", { command: "docker exec -it foo sh" }),
    ).toBe(false);
    expect(dockerCompressor.matches("bash", { command: "docker pull nginx" })).toBe(
      false,
    );
  });

  test("does NOT match non-bash tools", () => {
    expect(dockerCompressor.matches("read", { command: "docker ps" })).toBe(
      false,
    );
  });

  test("compresses docker ps -a table by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/docker/ps-a.input.txt", import.meta.url),
    ).text();
    const out = dockerCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
    // Header preserved
    expect(out).toContain("CONTAINER ID");
    expect(out).toContain("STATUS");
    // Summary line
    expect(out).toContain("running");
    expect(out).toContain("need attention");
    // Anomalous statuses surfaced
    expect(out).toContain("Exited");
    expect(out).toContain("Restarting");
    expect(out).toContain("unhealthy");
    // Healthy rows dropped (not all of them)
    expect(out).not.toContain("web-server");
    expect(out).not.toContain("db-primary");
  });

  test("all-healthy large ps table still compresses to summary", () => {
    const lines: string[] = [
      "CONTAINER ID   IMAGE          STATUS          NAMES",
    ];
    for (let i = 0; i < 30; i++) {
      lines.push(
        `a1b2c3d4e5${i}   nginx:latest   Up ${i} minutes   web-${i}`,
      );
    }
    const input = lines.join("\n");
    const out = dockerCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("30 running");
    expect(out).toContain("0 need attention");
  });

  test("compresses docker build by >= 50%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/docker/build.input.txt", import.meta.url),
    ).text();
    const out = dockerCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.5); // at least 50% reduction
    // Summary preserved
    expect(out).toContain("Successfully built");
    expect(out).toContain("Successfully tagged");
    expect(out).toContain("foo-web:latest");
    // Step/hash noise dropped
    expect(out).not.toContain("Step 1/20");
    expect(out).not.toContain("Removing intermediate container");
  });

  test("compresses docker compose up by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/docker/compose-up.input.txt", import.meta.url),
    ).text();
    const out = dockerCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
    // Service state changes preserved
    expect(out).toContain("Creating myapp-db-1");
    expect(out).toContain("Attaching to");
    expect(out).toContain("exited with code");
    // Error lines preserved
    expect(out).toContain("[ERROR]");
    // Pull noise dropped
    expect(out).not.toContain("Pull complete");
    expect(out).not.toContain("Digest:");
  });

  test("tiny input passes through unchanged", () => {
    const input = "CONTAINER ID   IMAGE   STATUS   NAMES";
    expect(dockerCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not docker output\nat all\nnothing here\n".repeat(20);
    expect(dockerCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k ps rows)", () => {
    const lines: string[] = [
      "CONTAINER ID   IMAGE          STATUS          NAMES",
    ];
    for (let i = 0; i < 10000; i++) {
      lines.push(`a1b2c3d4e5${i}   nginx:latest   Up ${i}m   web-${i}`);
    }
    const input = lines.join("\n");
    const t0 = performance.now();
    dockerCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
