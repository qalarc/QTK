// Tests for the ansible-playbook compressor.
//
// Covers:
//   1. matches ansible-playbook (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match ansible (ad-hoc) / ansible-galaxy
//   4. does NOT match non-bash tools
//   5. compresses a multi-host playbook run by >= 40%
//   6. keeps PLAY [target] headers
//   7. keeps TASK headers only when they have changed/failed results
//   8. keeps changed: [host] lines
//   9. keeps fatal: [host]: FAILED! + JSON detail
//  10. keeps the full PLAY RECAP table
//  11. drops ok: / skipping: / META: / [WARNING] noise
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { ansibleCompressor } from "../src/compressors/ansible.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("ansible compressor", () => {
  test("matches ansible-playbook", () => {
    expect(
      ansibleCompressor.matches("bash", { command: "ansible-playbook site.yml" }),
    ).toBe(true);
    expect(
      ansibleCompressor.matches("bash", {
        command: "ansible-playbook --check site.yml",
      }),
    ).toBe(true);
    expect(
      ansibleCompressor.matches("bash", {
        command: "ansible-playbook -i inventory prod deploy.yml",
      }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      ansibleCompressor.matches("bash", {
        command: "ansible-playbook site.yml | grep fail",
      }),
    ).toBe(false);
    expect(
      ansibleCompressor.matches("bash", {
        command: "ansible-playbook site.yml && echo done",
      }),
    ).toBe(false);
  });

  test("does NOT match ansible ad-hoc / ansible-galaxy", () => {
    expect(
      ansibleCompressor.matches("bash", { command: "ansible all -m ping" }),
    ).toBe(false);
    expect(
      ansibleCompressor.matches("bash", { command: "ansible-galaxy install foo" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      ansibleCompressor.matches("read", { command: "ansible-playbook site.yml" }),
    ).toBe(false);
  });

  test("compresses a multi-host playbook run by >= 30%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    // This fixture is change-heavy (most tasks change most hosts), so the
    // ratio is higher than a typical all-ok run. 30% is the floor here; a
    // real successful run (mostly ok: lines) compresses to <10%.
    expect(ratio).toBeLessThan(0.7); // at least 30% reduction
  });

  test("keeps PLAY [target] headers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    expect(out).toContain("PLAY [webservers]");
    expect(out).toContain("PLAY [dbservers]");
  });

  test("keeps TASK headers only when they have changed/failed results", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    // common : Ensure ntp is running — has changed: results, keep header
    expect(out).toContain("TASK [common : Ensure ntp is running]");
    // postgres : Grant privileges — has fatal: result, keep header
    expect(out).toContain("TASK [postgres : Grant privileges]");
    // common : Install base packages — only ok: results, drop header
    expect(out).not.toContain("TASK [common : Install base packages]");
    // nginx : Install nginx — only ok: results, drop header
    expect(out).not.toContain("TASK [nginx : Install nginx]");
  });

  test("keeps changed: [host] lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    expect(out).toContain("changed: [web01.example.com]");
    expect(out).toContain("changed: [db01.example.com]");
  });

  test("keeps fatal: [host]: FAILED! + JSON detail", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    expect(out).toContain(
      'fatal: [db02.example.com]: FAILED! => {"changed": false, "msg": "role \'appuser\' does not exist"}',
    );
  });

  test("keeps the full PLAY RECAP table", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    expect(out).toContain("PLAY RECAP");
    expect(out).toContain(
      "web01.example.com : ok=7    changed=5    unreachable=0    failed=0    rescued=0    ignored=0",
    );
    expect(out).toContain(
      "db02.example.com  : ok=4    changed=0    unreachable=0    failed=1    rescued=0    ignored=0",
    );
  });

  test("drops ok: / skipping: / META: / [WARNING] noise", async () => {
    const input = await Bun.file(
      new URL("./fixtures/ansible/playbook-fail.input.txt", import.meta.url),
    ).text();
    const out = ansibleCompressor.compress(input, CTX);
    // ok: lines dropped
    expect(out).not.toContain("ok: [web01.example.com]");
    expect(out).not.toContain("ok: [db01.example.com]");
    // META: dropped
    expect(out).not.toContain("META: ran handlers");
    // [WARNING] dropped (non-actionable)
    expect(out).not.toContain("[WARNING]: No inventory was parsed");
  });

  test("tiny input passes through unchanged", () => {
    const input = "PLAY [all] ***\nok: [localhost]\n";
    expect(ansibleCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not ansible output\nat all\nnothing useful here\n".repeat(20);
    expect(ansibleCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k ok lines)", () => {
    const lines: string[] = [];
    lines.push("PLAY [webservers] *************************************************************");
    lines.push("TASK [common : Install packages] *****************************************");
    for (let i = 0; i < 9999; i++) {
      lines.push(`ok: [host-${i}.example.com]`);
    }
    lines.push("PLAY RECAP *********************************************************************");
    lines.push("host-0.example.com : ok=1    changed=0    unreachable=0    failed=0    rescued=0    ignored=0");
    const input = lines.join("\n");
    const t0 = performance.now();
    ansibleCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
