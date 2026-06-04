import type { RiskPolicy, RiskReview, TradeIntent } from "@openstrat/domain";

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
