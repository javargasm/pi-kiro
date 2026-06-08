import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts", "pi-kiro-debug.sh");

describe("pi-kiro debug launcher", () => {
  it("sets debug logging defaults in dry-run mode", () => {
    expect(existsSync(scriptPath)).toBe(true);

    const stdout = execFileSync("bash", [scriptPath, "--version"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_KIRO_DEBUG_DRY_RUN: "1",
        KIRO_LOG: "",
        KIRO_LOG_FILE: "",
      },
      encoding: "utf8",
    });

    expect(stdout).toContain("KIRO_LOG=debug");
    expect(stdout).toContain(`KIRO_LOG_FILE=${join(repoRoot, ".pi", "kiro-debug.jsonl")}`);
    expect(stdout).toContain("COMMAND=pi --version");
  });

  it("preserves explicit debug env overrides", () => {
    expect(existsSync(scriptPath)).toBe(true);

    const stdout = execFileSync("bash", [scriptPath, "hello"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_KIRO_DEBUG_DRY_RUN: "1",
        KIRO_LOG: "info",
        KIRO_LOG_FILE: "/tmp/custom-kiro.log",
      },
      encoding: "utf8",
    });

    expect(stdout).toContain("KIRO_LOG=info");
    expect(stdout).toContain("KIRO_LOG_FILE=/tmp/custom-kiro.log");
    expect(stdout).toContain("COMMAND=pi hello");
  });
});
