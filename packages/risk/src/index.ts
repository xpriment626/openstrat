import {
  RiskReviewSchema,
  type MarketDatum,
  type MarketRegistryEntry,
  type RiskCheck,
  type RiskPolicy,
  type RiskReview,
  type TradeIntent
} from "@openstrat/domain";

export const riskPackageName = "@openstrat/risk" as const;

export interface RiskContext {
  market_refs: string[];
  portfolio_ref?: string;
  decision_ref?: string;
}

export interface RiskPolicyEngine {
  review(
    intent: TradeIntent,
    policy: RiskPolicy,
    context: RiskContext
  ): Promise<RiskReview>;
}

export interface TradeIntentRiskContext {
  now: string;
  review_id?: string;
  market: MarketRegistryEntry;
  latest_market_data?: MarketDatum;
  estimated_slippage_bps?: number;
  current_drawdown_pct?: number;
  current_daily_loss_usd?: number;
}

export function validateTradeIntentRisk(
  intent: TradeIntent,
  policy: RiskPolicy,
  context: TradeIntentRiskContext
): RiskReview {
  const checks: RiskCheck[] = [];

  checks.push(checkMarketStatus(context.market));
  checks.push(checkAllowedSymbol(intent, policy));
  checks.push(checkMode(intent, policy));
  checks.push(checkEvidence(intent, policy));
  checks.push(checkKillSwitch(policy));
  checks.push(checkNotional(intent, policy, context.latest_market_data));
  checks.push(checkLeverage(intent, policy));
  checks.push(checkDailyLoss(policy, context.current_daily_loss_usd ?? 0));
  checks.push(checkDrawdown(policy, context.current_drawdown_pct ?? 0));
  checks.push(checkFreshness(policy, context));
  checks.push(checkSlippage(policy, context.estimated_slippage_bps));

  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const freshnessFailed = checks.some(
    (check) => check.name === "data_freshness" && check.status === "fail"
  );
  const simulationMissing = checks.some(
    (check) => check.name === "slippage_budget" && check.message.includes("simulation")
  );

  const status = freshnessFailed
    ? "stale_data"
    : failed
      ? "rejected"
      : simulationMissing
        ? "simulation_required"
        : warned
          ? "needs_review"
          : "approved";

  return RiskReviewSchema.parse({
    id: context.review_id ?? `${intent.id}:${policy.id}:${context.now}`,
    intent_id: intent.id,
    policy_id: policy.id,
    created_at: context.now,
    status,
    checks,
    estimated_execution:
      context.estimated_slippage_bps === undefined
        ? undefined
        : {
            estimated_slippage_bps: context.estimated_slippage_bps,
            liquidity_source_refs: context.latest_market_data?.raw_ref
              ? [context.latest_market_data.raw_ref]
              : []
          },
    required_approvals: status === "needs_review" ? ["risk"] : []
  });
}

function checkMarketStatus(market: MarketRegistryEntry): RiskCheck {
  if (market.status === "active") {
    return pass("market_status", "Market is active.", market.status);
  }
  if (market.status === "low_liquidity" || market.status === "degraded") {
    return warn(
      "market_status",
      `Market status requires review: ${market.status}.`,
      market.status
    );
  }
  return fail(
    "market_status",
    `Market is not actionable: ${market.status}.`,
    market.status
  );
}

function checkAllowedSymbol(intent: TradeIntent, policy: RiskPolicy): RiskCheck {
  return policy.allowed_symbols.includes(intent.canonical_symbol)
    ? pass("allowed_symbol", "Symbol is allowed by policy.", intent.canonical_symbol)
    : fail(
        "allowed_symbol",
        "Symbol is not allowed by policy.",
        intent.canonical_symbol
      );
}

function checkMode(intent: TradeIntent, policy: RiskPolicy): RiskCheck {
  const allowed = allowedIntentModes(policy.mode);
  return allowed.includes(intent.mode)
    ? pass("mode", "Intent mode is allowed by policy.", intent.mode)
    : fail("mode", "Intent mode exceeds policy autonomy.", intent.mode, allowed);
}

function checkEvidence(intent: TradeIntent, policy: RiskPolicy): RiskCheck {
  if (!policy.require_evidence_refs) {
    return pass(
      "required_evidence_refs",
      "Evidence refs are not required by policy.",
      false
    );
  }
  return intent.evidence_refs.length > 0
    ? pass(
        "required_evidence_refs",
        "Intent includes evidence refs.",
        intent.evidence_refs.length
      )
    : fail("required_evidence_refs", "Intent is missing required evidence refs.", 0);
}

function checkKillSwitch(policy: RiskPolicy): RiskCheck {
  return policy.kill_switch
    ? fail("kill_switch", "Policy kill switch is active.", true)
    : pass("kill_switch", "Policy kill switch is inactive.", false);
}

function checkNotional(
  intent: TradeIntent,
  policy: RiskPolicy,
  latestMarketData?: MarketDatum
): RiskCheck {
  const notional = targetNotional(intent, latestMarketData);
  if (notional === undefined) {
    return fail(
      "max_notional",
      "Intent has no computable notional.",
      undefined,
      policy.max_notional_usd
    );
  }
  if (notional > policy.max_notional_usd) {
    return fail(
      "max_notional",
      "Intent exceeds max notional.",
      notional,
      policy.max_notional_usd
    );
  }
  if (notional >= policy.max_notional_usd * 0.8) {
    return warn(
      "max_notional",
      "Intent is near max notional.",
      notional,
      policy.max_notional_usd
    );
  }
  return pass(
    "max_notional",
    "Intent stays within max notional.",
    notional,
    policy.max_notional_usd
  );
}

function checkLeverage(intent: TradeIntent, policy: RiskPolicy): RiskCheck {
  const leverage = intent.leverage ?? 1;
  if (leverage > policy.max_leverage) {
    return fail(
      "max_leverage",
      "Intent exceeds max leverage.",
      leverage,
      policy.max_leverage
    );
  }
  if (leverage >= policy.max_leverage * 0.8) {
    return warn(
      "max_leverage",
      "Intent is near max leverage.",
      leverage,
      policy.max_leverage
    );
  }
  return pass(
    "max_leverage",
    "Intent stays within max leverage.",
    leverage,
    policy.max_leverage
  );
}

function checkDailyLoss(policy: RiskPolicy, dailyLossUsd: number): RiskCheck {
  if (policy.max_daily_loss_usd === undefined) {
    return pass("max_daily_loss", "Policy has no daily loss cap.", dailyLossUsd);
  }
  if (dailyLossUsd > policy.max_daily_loss_usd) {
    return fail(
      "max_daily_loss",
      "Daily loss exceeds policy cap.",
      dailyLossUsd,
      policy.max_daily_loss_usd
    );
  }
  if (dailyLossUsd >= policy.max_daily_loss_usd * 0.8) {
    return warn(
      "max_daily_loss",
      "Daily loss is near policy cap.",
      dailyLossUsd,
      policy.max_daily_loss_usd
    );
  }
  return pass(
    "max_daily_loss",
    "Daily loss is within policy cap.",
    dailyLossUsd,
    policy.max_daily_loss_usd
  );
}

function checkDrawdown(policy: RiskPolicy, drawdownPct: number): RiskCheck {
  if (policy.max_drawdown_pct === undefined) {
    return pass("max_drawdown", "Policy has no drawdown cap.", drawdownPct);
  }
  if (drawdownPct > policy.max_drawdown_pct) {
    return fail(
      "max_drawdown",
      "Drawdown exceeds policy cap.",
      drawdownPct,
      policy.max_drawdown_pct
    );
  }
  if (drawdownPct >= policy.max_drawdown_pct * 0.8) {
    return warn(
      "max_drawdown",
      "Drawdown is near policy cap.",
      drawdownPct,
      policy.max_drawdown_pct
    );
  }
  return pass(
    "max_drawdown",
    "Drawdown is within policy cap.",
    drawdownPct,
    policy.max_drawdown_pct
  );
}

function checkFreshness(
  policy: RiskPolicy,
  context: TradeIntentRiskContext
): RiskCheck {
  const latest = context.latest_market_data;
  if (latest === undefined) {
    return fail(
      "data_freshness",
      "Latest market data is missing.",
      undefined,
      policy.stale_after_ms
    );
  }

  const ageMs = Date.parse(context.now) - Date.parse(latest.received_at);
  const limitMs = Math.min(policy.stale_after_ms, latest.stale_after_ms);
  return ageMs <= limitMs
    ? pass("data_freshness", "Latest market data is fresh.", ageMs, limitMs)
    : fail("data_freshness", "Latest market data is stale.", ageMs, limitMs);
}

function checkSlippage(policy: RiskPolicy, estimatedSlippageBps?: number): RiskCheck {
  if (estimatedSlippageBps === undefined) {
    return warn(
      "slippage_budget",
      "Execution simulation required before approval.",
      undefined,
      policy.max_slippage_bps
    );
  }
  if (estimatedSlippageBps > policy.max_slippage_bps) {
    return fail(
      "slippage_budget",
      "Estimated slippage exceeds policy cap.",
      estimatedSlippageBps,
      policy.max_slippage_bps
    );
  }
  if (estimatedSlippageBps >= policy.max_slippage_bps * 0.8) {
    return warn(
      "slippage_budget",
      "Estimated slippage is near policy cap.",
      estimatedSlippageBps,
      policy.max_slippage_bps
    );
  }
  return pass(
    "slippage_budget",
    "Estimated slippage is within policy cap.",
    estimatedSlippageBps,
    policy.max_slippage_bps
  );
}

function targetNotional(
  intent: TradeIntent,
  latestMarketData?: MarketDatum
): number | undefined {
  if (intent.target_notional_usd !== undefined) {
    return intent.target_notional_usd;
  }
  if (
    intent.target_quantity !== undefined &&
    latestMarketData !== undefined &&
    typeof latestMarketData.value === "number"
  ) {
    return intent.target_quantity * latestMarketData.value;
  }
  return undefined;
}

function allowedIntentModes(policyMode: RiskPolicy["mode"]): TradeIntent["mode"][] {
  switch (policyMode) {
    case "research_only":
      return ["research"];
    case "strategy_workbench":
      return ["research"];
    case "paper_trading":
      return ["research", "paper"];
    case "draft_orders":
      return ["research", "paper", "draft"];
    case "constrained_live":
    case "adaptive_management":
      return ["research", "paper", "draft", "live"];
    default:
      throw new Error(`Unsupported risk policy mode: ${policyMode}`);
  }
}

function pass(
  name: string,
  message: string,
  value?: unknown,
  limit?: unknown
): RiskCheck {
  return { name, status: "pass", message, value, limit };
}

function warn(
  name: string,
  message: string,
  value?: unknown,
  limit?: unknown
): RiskCheck {
  return { name, status: "warn", message, value, limit };
}

function fail(
  name: string,
  message: string,
  value?: unknown,
  limit?: unknown
): RiskCheck {
  return { name, status: "fail", message, value, limit };
}
