import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenStratCli } from "./commands.js";

describe("openstrat CLI commands", () => {
  it("initializes, doctors, runs fake chat, lists artifacts, upgrades dry-run, and purges", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = {
      HOME: userHome,
      OPENSTRAT_FAKE_PI: "1",
      OPENSTRAT_FAKE_HYPERLIQUID: "1",
      OPENSTRAT_SKIP_EXTERNAL_CLI_CHECKS: "1"
    };

    const init = await runOpenStratCli({ argv: ["init"], cwd, env });
    const secondInit = await runOpenStratCli({ argv: ["init"], cwd, env });
    const doctor = await runOpenStratCli({ argv: ["doctor"], cwd, env });
    const chat = await runOpenStratCli({
      argv: ["chat", "--prompt", "hello"],
      cwd,
      env
    });
    const artifacts = await runOpenStratCli({ argv: ["artifacts"], cwd, env });
    const gateway = await runOpenStratCli({ argv: ["gateway"], cwd, env });
    const upgrade = await runOpenStratCli({ argv: ["upgrade"], cwd, env });
    const update = await runOpenStratCli({
      argv: ["update", "--tag", "dev"],
      cwd,
      env
    });
    const purge = await runOpenStratCli({ argv: ["reset", "--purge"], cwd, env });
    const afterPurge = await runOpenStratCli({ argv: ["doctor"], cwd, env });

    expect(init.exitCode).toBe(0);
    expect(secondInit.stdout.join("\n")).toContain("already registered");
    expect(doctor.stdout.join("\n")).toContain("Codex auth: missing");
    expect(doctor.stdout.join("\n")).not.toContain("access-token");
    expect(chat.stdout.join("\n")).toContain("Hello from OpenStrat");
    expect(chat.stdout.join("\n")).toContain(
      "disabled native tools: read,bash,edit,write"
    );
    expect(artifacts.stdout.join("\n")).toContain("agent_session_");
    expect(gateway.stdout.join("\n")).toContain("OpenStrat Gateway");
    expect(upgrade.stdout.join("\n")).toContain("npm i -g openstrat@dev");
    expect(update.stdout.join("\n")).toContain("npm i -g openstrat@dev");
    expect(purge.stdout.join("\n")).toContain("Purged");
    expect(afterPurge.stdout.join("\n")).toContain("home initialized: no");
  });

  it("reports Codex auth from the Pi auth file without leaking tokens", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = {
      HOME: userHome,
      OPENSTRAT_FAKE_CODEX_AUTH: "1"
    };

    const auth = await runOpenStratCli({ argv: ["auth", "codex"], cwd, env });
    const doctor = await runOpenStratCli({ argv: ["doctor"], cwd, env });
    const authPath = join(userHome, ".openstrat", "dev-v0", "auth", "pi-auth.json");

    expect(auth.stdout.join("\n")).toContain("openai-codex");
    expect(existsSync(authPath)).toBe(true);
    expect(readFileSync(authPath, "utf8")).toContain("openai-codex");
    expect(doctor.stdout.join("\n")).toContain("Codex auth: configured");
    expect(doctor.stdout.join("\n")).not.toContain("fake-access-token");
    expect(doctor.stdout.join("\n")).not.toContain("fake-refresh-token");
  });

  it("prints final assistant text when Pi does not stream text deltas", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const chat = await runOpenStratCli({
      argv: ["chat", "--prompt", "hello"],
      cwd,
      env: {
        HOME: userHome,
        OPENSTRAT_FAKE_PI: "1",
        OPENSTRAT_FAKE_PI_FINAL_ONLY: "1"
      }
    });

    expect(chat.exitCode).toBe(0);
    expect(chat.stdout.join("\n")).toContain("Final assistant text from Pi.");
    expect(chat.stdout.join("\n")).not.toContain("OpenStrat chat session completed.");
  });

  it("generates explicit upgrade commands and never self-updates silently", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const dryRun = await runOpenStratCli({
      argv: ["upgrade", "--version", "0.0.2"],
      cwd,
      env: { HOME: userHome }
    });

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.join("\n")).toContain("Dry run");
    expect(dryRun.stdout.join("\n")).toContain("npm i -g openstrat@0.0.2");
  });
});
