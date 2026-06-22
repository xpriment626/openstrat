import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileObjectStore, SqliteEventLog } from "./index.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openstrat-persistence-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteEventLog", () => {
  it("appends events and lists them in sequence order", () => {
    const log = new SqliteEventLog(join(tempDir, "events.sqlite"));

    const first = log.append({
      stream_id: "strategy/eth_breakout",
      type: "decision.created",
      occurred_at: "2026-06-04T00:00:00.000Z",
      payload: { decision_ref: "decision_001" },
      metadata: { source: "test" }
    });
    const second = log.append({
      stream_id: "strategy/eth_breakout",
      type: "intent.created",
      occurred_at: "2026-06-04T00:01:00.000Z",
      payload: { intent_ref: "intent_001" }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.list("strategy/eth_breakout").map((event) => event.type)).toEqual([
      "decision.created",
      "intent.created"
    ]);

    log.close();
  });

  it("does not expose overwrite primitives and isolates returned event mutations", () => {
    const log = new SqliteEventLog(join(tempDir, "events.sqlite"));
    const event = log.append({
      stream_id: "strategy/eth_breakout",
      type: "intent.created",
      payload: { status: "draft" }
    });

    const returned = log.get(event.sequence);
    expect(returned).toBeDefined();
    if (
      !returned ||
      typeof returned.payload !== "object" ||
      returned.payload === null
    ) {
      throw new Error("Expected object payload");
    }

    (returned.payload as { status: string }).status = "mutated";

    expect(log.get(event.sequence)?.payload).toEqual({ status: "draft" });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(log))).not.toEqual(
      expect.arrayContaining(["overwrite", "replace", "update", "delete"])
    );

    log.close();
  });

  it("installs a SQLite trigger that rejects direct event row updates", () => {
    const dbPath = join(tempDir, "events.sqlite");
    const log = new SqliteEventLog(dbPath);
    const event = log.append({
      stream_id: "strategy/eth_breakout",
      type: "intent.created",
      payload: { status: "draft" }
    });
    log.close();

    const db = new DatabaseSync(dbPath);
    expect(() =>
      db
        .prepare("UPDATE event_log SET type = ? WHERE sequence = ?")
        .run("intent.changed", event.sequence)
    ).toThrow(/append-only/);
    db.close();
  });
});

describe("FileObjectStore", () => {
  it("stores JSON artifacts under guarded refs", () => {
    const store = new FileObjectStore(join(tempDir, "objects"));

    store.putJson("raw/hyperliquid/eth-mark.json", {
      source: "hyperliquid",
      value: 3650.25
    });

    expect(store.exists("raw/hyperliquid/eth-mark.json")).toBe(true);
    expect(store.getJson("raw/hyperliquid/eth-mark.json")).toEqual({
      source: "hyperliquid",
      value: 3650.25
    });
  });

  it("rejects accidental overwrites unless explicitly requested", () => {
    const store = new FileObjectStore(join(tempDir, "objects"));
    store.putJson("backtests/run_001/report.json", { run_id: "run_001" });

    expect(() =>
      store.putJson("backtests/run_001/report.json", { run_id: "changed" })
    ).toThrow(/already exists/);

    store.putJson(
      "backtests/run_001/report.json",
      { run_id: "changed" },
      { overwrite: true }
    );
    expect(store.getJson("backtests/run_001/report.json")).toEqual({
      run_id: "changed"
    });
  });

  it("rejects refs that escape the store root", () => {
    const store = new FileObjectStore(join(tempDir, "objects"));

    expect(() => store.putJson("../escape.json", {})).toThrow(/escapes store root/);
    expect(() => store.putJson("/tmp/escape.json", {})).toThrow(/Invalid object ref/);
  });
});
