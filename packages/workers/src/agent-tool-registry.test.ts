import { describe, expect, it } from "vitest";
import {
  agentToolGatewayToolDefinition,
  agentToolGatewayToolNames,
  agentToolGrantAllows
} from "./agent-tool-registry.js";

const now = "2026-06-14T00:00:00.000Z";

describe("agent tool registry", () => {
  it("exposes names, schemas, side effects, and grant requirements from one registry", () => {
    expect(agentToolGatewayToolNames()).toEqual([
      "market_data.read_snapshot",
      "backtest.request",
      "risk.validate_intent",
      "strategy_patch.capture",
      "memory_proposal.capture",
      "deployment_gate.inspect"
    ]);

    const marketTool = agentToolGatewayToolDefinition("market_data.read_snapshot");
    expect(marketTool).toMatchObject({
      name: "market_data.read_snapshot",
      side_effect: "none",
      grant: {
        permission: "read",
        scope: "market_data"
      }
    });
    expect(
      marketTool.input_schema.safeParse({
        canonical_symbol: "ETH-PERP",
        source: "hyperliquid",
        venue: "hyperliquid"
      }).success
    ).toBe(true);
    expect(
      marketTool.input_schema.safeParse({
        canonical_symbol: "eth-perp"
      }).success
    ).toBe(false);
    expect(
      marketTool.output_schema.safeParse({
        market: {
          canonical_symbol: "ETH-PERP",
          display_symbol: "ETH",
          venue_symbol: "ETH",
          venue: "hyperliquid",
          source: "hyperliquid",
          asset_class: "crypto",
          quote_token: "USDC",
          status: "active",
          last_verified_at: now,
          source_refs: ["market-registry/hyperliquid/eth.json"]
        },
        latest_price: {
          value: 3500,
          source: "hyperliquid",
          venue: "hyperliquid",
          symbol: "ETH",
          canonical_symbol: "ETH-PERP",
          method: "mark",
          timestamp: now,
          received_at: now,
          stale_after_ms: 5000,
          raw_ref: "market-data/hyperliquid/eth/latest.json"
        }
      }).success
    ).toBe(true);
  });

  it("checks session grants against registry requirements", () => {
    const grant = {
      id: "grant_market_read",
      created_at: now,
      session_id: "agent_session_001",
      tool_name: "market_data.read_snapshot",
      permission: "read" as const,
      scope: "market_data" as const,
      expires_at: "2026-06-14T01:00:00.000Z"
    };

    expect(
      agentToolGrantAllows("market_data.read_snapshot", grant, {
        now: "2026-06-14T00:30:00.000Z"
      })
    ).toBe(true);
    expect(
      agentToolGrantAllows(
        "market_data.read_snapshot",
        {
          ...grant,
          permission: "inspect"
        },
        { now: "2026-06-14T00:30:00.000Z" }
      )
    ).toBe(false);
    expect(
      agentToolGrantAllows("market_data.read_snapshot", grant, {
        now: "2026-06-14T01:00:01.000Z"
      })
    ).toBe(false);
    expect(
      agentToolGrantAllows("deployment_gate.inspect", grant, {
        now: "2026-06-14T00:30:00.000Z"
      })
    ).toBe(false);
  });
});
