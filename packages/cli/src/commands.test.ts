import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventLog } from "@openstrat/persistence";
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
      OPENSTRAT_FAKE_CODEX_AUTH: "1",
      OPENSTRAT_FAKE_HYPERLIQUID: "1",
      OPENSTRAT_SKIP_EXTERNAL_CLI_CHECKS: "1"
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

  it("ingests fixture market data and reads typed market snapshots", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = { HOME: userHome };

    const ingest = await runOpenStratCli({
      argv: ["market", "ingest-fixture", "--symbol", "BTC", "--interval", "15m"],
      cwd,
      env
    });
    const datasetRef = ingest.stdout
      .find((line) => line.startsWith("dataset: "))
      ?.replace("dataset: ", "");

    expect(ingest.exitCode).toBe(0);
    expect(datasetRef).toBeDefined();

    const dataset = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", datasetRef ?? ""),
        "utf8"
      )
    ) as {
      canonical_symbol: string;
      dataset_ref: string;
      latest_price_ref: string;
      raw_refs: Record<string, string>;
      source: string;
      venue: string;
    };
    expect(dataset).toMatchObject({
      canonical_symbol: "BTC-PERP",
      dataset_ref: datasetRef,
      source: "hyperliquid",
      venue: "hyperliquid"
    });
    expect(dataset.raw_refs.meta_and_asset_ctxs).toContain("raw/hyperliquid");

    const list = await runOpenStratCli({ argv: ["market", "list"], cwd, env });
    expect(list.exitCode).toBe(0);
    expect(list.stdout.join("\n")).toContain("BTC-PERP hyperliquid hyperliquid");

    const snapshot = await runOpenStratCli({
      argv: ["market", "snapshot", "BTC-PERP"],
      cwd,
      env
    });
    const parsed = JSON.parse(snapshot.stdout.join("\n")) as {
      dataset_ref: string;
      latest_price: { raw_ref: string; stale_after_ms: number; venue: string };
      market: { canonical_symbol: string; source: string; venue: string };
    };

    expect(snapshot.exitCode).toBe(0);
    expect(parsed.dataset_ref).toBe(datasetRef);
    expect(parsed.market).toMatchObject({
      canonical_symbol: "BTC-PERP",
      source: "hyperliquid",
      venue: "hyperliquid"
    });
    expect(parsed.latest_price).toMatchObject({
      raw_ref: dataset.raw_refs.meta_and_asset_ctxs,
      stale_after_ms: 5000,
      venue: "hyperliquid"
    });
  });

  it("validates pure strategies, rejects impure strategies, and captures proposals", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = { HOME: userHome };

    const valid = await runOpenStratCli({
      argv: ["strategy", "validate", "--sample", "moving-average-breakout"],
      cwd,
      env
    });
    const invalid = await runOpenStratCli({
      argv: ["strategy", "validate", "--sample", "invalid-random"],
      cwd,
      env
    });
    const proposal = await runOpenStratCli({
      argv: [
        "strategy",
        "propose-sample",
        "--strategy-id",
        "sample_moving_average_breakout"
      ],
      cwd,
      env
    });
    const artifactRef = proposal.stdout
      .find((line) => line.startsWith("artifact: "))
      ?.replace("artifact: ", "");
    const patchRef = proposal.stdout
      .find((line) => line.startsWith("patch: "))
      ?.replace("patch: ", "");

    expect(valid.exitCode).toBe(0);
    expect(valid.stdout.join("\n")).toContain(
      "strategy valid: sample_moving_average_breakout"
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.join("\n")).toContain("forbidden API");
    expect(proposal.exitCode).toBe(0);
    expect(artifactRef).toContain("agent-artifacts/");
    expect(patchRef).toContain("scratch/");

    const proposalArtifact = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", artifactRef ?? ""),
        "utf8"
      )
    ) as { id: string; patch_ref: string; status: string };
    const patchBundle = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", patchRef ?? ""),
        "utf8"
      )
    ) as { files: { path: string; content: string }[] };

    expect(proposalArtifact).toMatchObject({
      patch_ref: patchRef,
      status: "proposed"
    });
    expect(patchBundle.files[0]).toMatchObject({
      path: "strategies/sample_moving_average_breakout.ts"
    });
  });

  it("runs a sample candle backtest and writes report artifacts", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = { HOME: userHome };

    const ingest = await runOpenStratCli({
      argv: ["market", "ingest-fixture", "--symbol", "BTC", "--interval", "15m"],
      cwd,
      env
    });
    const datasetRef = ingest.stdout
      .find((line) => line.startsWith("dataset: "))
      ?.replace("dataset: ", "");
    const backtest = await runOpenStratCli({
      argv: [
        "backtest",
        "run-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--dataset-ref",
        datasetRef ?? "",
        "--fee-bps",
        "5",
        "--slippage-bps",
        "10"
      ],
      cwd,
      env
    });
    const reportRef = backtest.stdout
      .find((line) => line.startsWith("report: "))
      ?.replace("report: ", "");
    const ledgerRef = backtest.stdout
      .find((line) => line.startsWith("trade_ledger: "))
      ?.replace("trade_ledger: ", "");

    expect(backtest.exitCode).toBe(0);
    expect(reportRef).toContain("backtests/");
    expect(ledgerRef).toContain("trade-ledger.json");

    const report = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", reportRef ?? ""),
        "utf8"
      )
    ) as {
      dataset_ref: string;
      metrics: { fees_usd: number; slippage_usd: number; trades: number };
      trade_ledger_ref: string;
    };
    const ledger = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", ledgerRef ?? ""),
        "utf8"
      )
    ) as unknown[];

    expect(report.dataset_ref).toBe(datasetRef);
    expect(report.trade_ledger_ref).toBe(ledgerRef);
    expect(report.metrics).toMatchObject({
      fees_usd: expect.any(Number),
      slippage_usd: expect.any(Number),
      trades: expect.any(Number)
    });
    expect(Array.isArray(ledger)).toBe(true);
  });

  it("materializes deployment gates and blocks plans when requirements are missing", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = { HOME: userHome };

    const ingest = await runOpenStratCli({
      argv: ["market", "ingest-fixture", "--symbol", "BTC", "--interval", "15m"],
      cwd,
      env
    });
    const datasetRef = ingest.stdout
      .find((line) => line.startsWith("dataset: "))
      ?.replace("dataset: ", "");
    const backtest = await runOpenStratCli({
      argv: [
        "backtest",
        "run-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--dataset-ref",
        datasetRef ?? "",
        "--fee-bps",
        "5",
        "--slippage-bps",
        "10"
      ],
      cwd,
      env
    });
    const reportRef = backtest.stdout
      .find((line) => line.startsWith("report: "))
      ?.replace("report: ", "");

    const readyGate = await runOpenStratCli({
      argv: [
        "gate",
        "create-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--backtest-report-ref",
        reportRef ?? "",
        "--risk-policy-ref",
        "risk/sample",
        "--ready"
      ],
      cwd,
      env
    });
    const readyGateRef = readyGate.stdout
      .find((line) => line.startsWith("gate: "))
      ?.replace("gate: ", "");
    const readyArtifactRef = readyGate.stdout
      .find((line) => line.startsWith("artifact: "))
      ?.replace("artifact: ", "");
    const readyInspect = await runOpenStratCli({
      argv: ["gate", "inspect", readyArtifactRef ?? ""],
      cwd,
      env
    });
    const readyPlan = await runOpenStratCli({
      argv: ["deploy", "plan", "--gate-ref", readyGateRef ?? ""],
      cwd,
      env
    });

    expect(readyGate.exitCode).toBe(0);
    expect(readyGateRef).toContain("deployment-gates/");
    expect(readyArtifactRef).toContain("deployment-gate-artifacts/");
    expect(JSON.parse(readyInspect.stdout.join("\n"))).toMatchObject({
      ready: true,
      missing_requirements: []
    });
    expect(readyPlan.exitCode).toBe(0);
    expect(readyPlan.stdout.join("\n")).toContain("deployment plan: local_terminal");

    const readyArtifact = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", readyArtifactRef ?? ""),
        "utf8"
      )
    ) as {
      backtest_report_ref: string;
      gate_ref: string;
      risk_policy_ref: string;
      strategy_ref: string;
    };
    expect(readyArtifact).toMatchObject({
      backtest_report_ref: reportRef,
      gate_ref: readyGateRef,
      risk_policy_ref: "risk/sample",
      strategy_ref: "sample_moving_average_breakout"
    });

    const blockedGate = await runOpenStratCli({
      argv: [
        "gate",
        "create-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--backtest-report-ref",
        reportRef ?? "",
        "--risk-policy-ref",
        "risk/sample",
        "--not-ready"
      ],
      cwd,
      env
    });
    const blockedGateRef = blockedGate.stdout
      .find((line) => line.startsWith("gate: "))
      ?.replace("gate: ", "");
    const blockedInspect = await runOpenStratCli({
      argv: ["gate", "inspect", blockedGateRef ?? ""],
      cwd,
      env
    });
    const blockedPlan = await runOpenStratCli({
      argv: ["deploy", "plan", "--gate-ref", blockedGateRef ?? ""],
      cwd,
      env
    });
    const blockedInspection = JSON.parse(blockedInspect.stdout.join("\n")) as {
      missing_requirements: string[];
      ready: boolean;
    };

    expect(blockedGate.exitCode).toBe(0);
    expect(blockedInspection.ready).toBe(false);
    expect(blockedInspection.missing_requirements).toEqual(
      expect.arrayContaining([
        "fee-inclusive backtest required",
        "slippage-model backtest required",
        "risk review required",
        "deployment kill switch is active"
      ])
    );
    expect(blockedPlan.exitCode).toBe(1);
    expect(blockedPlan.stderr.join("\n")).toContain("deployment gate is not ready");
    expect(blockedPlan.stderr.join("\n")).toContain("fee-inclusive backtest required");
  });

  it("records decision ledger entries and proposes memory from evidence refs", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openstrat-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openstrat-workspace-"));
    const env = { HOME: userHome };

    const ingest = await runOpenStratCli({
      argv: ["market", "ingest-fixture", "--symbol", "BTC", "--interval", "15m"],
      cwd,
      env
    });
    const datasetRef = ingest.stdout
      .find((line) => line.startsWith("dataset: "))
      ?.replace("dataset: ", "");
    const backtest = await runOpenStratCli({
      argv: [
        "backtest",
        "run-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--dataset-ref",
        datasetRef ?? "",
        "--fee-bps",
        "5",
        "--slippage-bps",
        "10"
      ],
      cwd,
      env
    });
    const reportRef = backtest.stdout
      .find((line) => line.startsWith("report: "))
      ?.replace("report: ", "");
    const gate = await runOpenStratCli({
      argv: [
        "gate",
        "create-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--backtest-report-ref",
        reportRef ?? "",
        "--risk-policy-ref",
        "risk/sample",
        "--ready"
      ],
      cwd,
      env
    });
    const gateRef = gate.stdout
      .find((line) => line.startsWith("gate: "))
      ?.replace("gate: ", "");

    const decision = await runOpenStratCli({
      argv: [
        "ledger",
        "record-sample",
        "--strategy-ref",
        "sample_moving_average_breakout",
        "--dataset-ref",
        datasetRef ?? "",
        "--backtest-report-ref",
        reportRef ?? "",
        "--gate-ref",
        gateRef ?? ""
      ],
      cwd,
      env
    });
    const decisionRef = decision.stdout
      .find((line) => line.startsWith("decision: "))
      ?.replace("decision: ", "");
    const ledgerList = await runOpenStratCli({
      argv: ["ledger", "list"],
      cwd,
      env
    });

    expect(decision.exitCode).toBe(0);
    expect(decisionRef).toContain("decision-ledgers/");
    expect(ledgerList.stdout.join("\n")).toContain(decisionRef);

    const memory = await runOpenStratCli({
      argv: [
        "memory",
        "propose-sample",
        "--decision-ref",
        decisionRef ?? "",
        "--backtest-report-ref",
        reportRef ?? "",
        "--gate-ref",
        gateRef ?? ""
      ],
      cwd,
      env
    });
    const memoryRef = memory.stdout
      .find((line) => line.startsWith("artifact: "))
      ?.replace("artifact: ", "");
    const memoryList = await runOpenStratCli({
      argv: ["memory", "list"],
      cwd,
      env
    });

    expect(memory.exitCode).toBe(0);
    expect(memoryRef).toContain("agent-artifacts/");
    expect(memory.stdout.join("\n")).toContain("status: proposed");
    expect(memory.stdout.join("\n")).toContain("requires_human_review: yes");
    expect(memoryList.stdout.join("\n")).toContain(memoryRef);

    const decisionArtifact = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", decisionRef ?? ""),
        "utf8"
      )
    ) as {
      evidence_refs: string[];
      strategy_id: string;
      tags: string[];
    };
    const memoryArtifact = JSON.parse(
      readFileSync(
        join(userHome, ".openstrat", "dev-v0", "objects", memoryRef ?? ""),
        "utf8"
      )
    ) as {
      evidence_refs: string[];
      promotion_event_ref?: string;
      requires_human_review: boolean;
      status: string;
      subject_id: string;
      subject_type: string;
    };

    expect(decisionArtifact).toMatchObject({
      strategy_id: "sample_moving_average_breakout",
      tags: expect.arrayContaining(["sample", "e2e-scaffolding"])
    });
    expect(decisionArtifact.evidence_refs).toEqual(
      expect.arrayContaining([datasetRef, reportRef, gateRef])
    );
    expect(memoryArtifact).toMatchObject({
      requires_human_review: true,
      status: "proposed",
      subject_id: "sample_moving_average_breakout",
      subject_type: "strategy"
    });
    expect(memoryArtifact.evidence_refs).toEqual(
      expect.arrayContaining([decisionRef, reportRef, gateRef])
    );
    expect(memoryArtifact.promotion_event_ref).toBeUndefined();

    const events = new SqliteEventLog(
      join(userHome, ".openstrat", "dev-v0", "state.sqlite")
    );
    try {
      const storedEvents = events.list();
      expect(storedEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining(["agent.decision.recorded", "agent.proposal.captured"])
      );
      expect(
        storedEvents.find((event) => event.type === "agent.proposal.captured")?.payload
      ).toMatchObject({
        tool_name: "memory_proposal.capture"
      });
    } finally {
      events.close();
    }
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
