// Tests for the terraform plan / terraform apply compressor.
//
// Covers:
//   1. matches terraform plan / apply (with/without args/flags)
//   2. does NOT match piped/compound commands
//   3. does NOT match terraform init / fmt / validate
//   4. does NOT match non-bash tools
//   5. compresses a plan output by >= 40%
//   6. keeps resource action markers (# <res> will be created/destroyed/...)
//   7. keeps the + / - / ~ / -/+ diff lines
//   8. keeps the Plan: N to add, M to change, K to destroy. summary
//   9. keeps the Changes to Outputs block
//  10. drops Refreshing state... / data.*: Reading / Read complete noise
//  11. drops the provider preamble + symbol legend + epilogue
//  12. tiny input passes through
//  13. garbage input passes through
//  14. adversarial input doesn't hang

import { describe, test, expect } from "bun:test";
import { terraformCompressor } from "../src/compressors/terraform.ts";

const CTX = { args: {}, cwd: "/tmp", config: {} };

describe("terraform compressor", () => {
  test("matches terraform plan / apply", () => {
    expect(
      terraformCompressor.matches("bash", { command: "terraform plan" }),
    ).toBe(true);
    expect(
      terraformCompressor.matches("bash", { command: "terraform apply" }),
    ).toBe(true);
    expect(
      terraformCompressor.matches("bash", {
        command: "terraform apply -auto-approve",
      }),
    ).toBe(true);
    expect(
      terraformCompressor.matches("bash", { command: "terraform apply tfplan" }),
    ).toBe(true);
    expect(
      terraformCompressor.matches("bash", {
        command: "terraform plan -out=tfplan",
      }),
    ).toBe(true);
  });

  test("does NOT match piped/compound commands", () => {
    expect(
      terraformCompressor.matches("bash", {
        command: "terraform plan | grep will",
      }),
    ).toBe(false);
    expect(
      terraformCompressor.matches("bash", {
        command: "terraform apply && echo done",
      }),
    ).toBe(false);
  });

  test("does NOT match terraform init / fmt / validate", () => {
    expect(
      terraformCompressor.matches("bash", { command: "terraform init" }),
    ).toBe(false);
    expect(
      terraformCompressor.matches("bash", { command: "terraform fmt" }),
    ).toBe(false);
    expect(
      terraformCompressor.matches("bash", { command: "terraform validate" }),
    ).toBe(false);
  });

  test("does NOT match non-bash tools", () => {
    expect(
      terraformCompressor.matches("read", { command: "terraform plan" }),
    ).toBe(false);
  });

  test("compresses a plan output by >= 40%", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out.length).toBeLessThan(input.length);
    const ratio = out.length / input.length;
    expect(ratio).toBeLessThan(0.6); // at least 40% reduction
  });

  test("keeps resource action markers", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out).toContain("# aws_instance.web will be created");
    expect(out).toContain("# aws_lb_target_group.web will be updated in-place");
    expect(out).toContain("# aws_security_group.web will be replaced");
    expect(out).toContain("# aws_s3_bucket.uploads will be destroyed");
    expect(out).toContain("# aws_db_instance.primary will be updated in-place");
  });

  test("keeps the + / - / ~ / -/+ diff lines", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    // + create lines
    expect(out).toContain('+ instance_type                        = "t3.medium"');
    expect(out).toContain('+ ami                                  = "ami-0abc123def456789a"');
    // ~ update lines
    expect(out).toContain("~ deregistration_delay   = 300 -> 60");
    expect(out).toContain("~ interval            = 30 -> 15");
    // - destroy lines
    expect(out).toContain("- bucket = \"my-app-uploads-bucket\" -> null");
    // -/+ replace is in the action marker line (tested above)
  });

  test("keeps the Plan: summary", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out).toContain("Plan: 2 to add, 3 to change, 2 to destroy.");
  });

  test("keeps the Changes to Outputs block", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out).toContain("Changes to Outputs:");
    expect(out).toContain("~ instance_public_ip = \"1.2.3.4\" -> (known after apply)");
    expect(out).toContain("+ lb_dns_name        = (known after apply)");
    expect(out).toContain("~ db_endpoint        = \"db-old.example.com\" -> (known after apply)");
  });

  test("drops Refreshing state / data.* Reading / Read complete noise", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out).not.toContain("Refreshing state...");
    expect(out).not.toContain("aws_instance.web: Refreshing state");
    expect(out).not.toContain("data.aws_ami.ubuntu: Reading...");
    expect(out).not.toContain("data.aws_ami.ubuntu: Read complete");
    expect(out).not.toContain("data.aws_caller_identity.current: Reading...");
  });

  test("drops provider preamble + symbol legend + epilogue", async () => {
    const input = await Bun.file(
      new URL("./fixtures/terraform/plan.input.txt", import.meta.url),
    ).text();
    const out = terraformCompressor.compress(input, CTX);
    expect(out).not.toContain("Terraform used the selected providers");
    expect(out).not.toContain("Resource actions are indicated");
    expect(out).not.toContain("Terraform will perform the following actions:");
    expect(out).not.toContain("Saved the plan to:");
    expect(out).not.toContain("To perform exactly these actions");
  });

  test("tiny input passes through unchanged", () => {
    const input = "Plan: 0 to add, 0 to change, 0 to destroy.";
    expect(terraformCompressor.compress(input, CTX)).toBe(input);
  });

  test("garbage input is returned unchanged", () => {
    const garbage =
      "this is not terraform output\nat all\nnothing useful here\n".repeat(20);
    expect(terraformCompressor.compress(garbage, CTX)).toBe(garbage);
  });

  test("adversarial input doesn't hang (10k refresh lines)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9999; i++) {
      lines.push(`aws_instance.web-${i}: Refreshing state... [id=i-${i}]`);
    }
    lines.push("# aws_instance.web-0 will be created");
    lines.push('  + resource "aws_instance" "web-0" {');
    lines.push('      + instance_type = "t3.micro"');
    lines.push("  }");
    lines.push("Plan: 1 to add, 0 to change, 0 to destroy.");
    const input = lines.join("\n");
    const t0 = performance.now();
    terraformCompressor.compress(input, CTX);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // 200ms max
  });
});
