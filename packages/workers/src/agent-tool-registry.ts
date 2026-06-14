import {
  AgentToolGrantSchema,
  BacktestRequestSchema,
  CanonicalSymbolSchema,
  DeploymentGateSchema,
  MarketDatumSchema,
  MarketRegistryEntrySchema,
  MemoryProposalSchema,
  NonEmptyStringSchema,
  RiskPolicySchema,
  RiskReviewSchema,
  SourceRefSchema,
  StrategyPatchProposalSchema,
  TradeIntentSchema,
  type AgentToolGrant,
  type AgentToolPermission,
  type AgentToolScope,
  type AgentToolSideEffect,
  type BacktestRequest,
  type DeploymentGate,
  type MarketDatum,
  type MarketRegistryEntry,
  type MemoryProposal,
  type RiskPolicy,
  type RiskReview,
  type StrategyPatchProposal,
  type TradeIntent
} from "@openstrat/domain";

export const AGENT_TOOL_GATEWAY_TOOLS = [
  "market_data.read_snapshot",
  "backtest.request",
  "risk.validate_intent",
  "strategy_patch.capture",
  "memory_proposal.capture",
  "deployment_gate.inspect"
] as const;

export type AgentToolGatewayToolName = (typeof AGENT_TOOL_GATEWAY_TOOLS)[number];

export type AgentToolSchemaResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

export interface AgentToolSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): AgentToolSchemaResult<T>;
}

export interface AgentToolGrantRequirement {
  permission: AgentToolPermission;
  scope: AgentToolScope;
}

export interface AgentToolGatewayToolDefinition<TInput = unknown, TOutput = unknown> {
  name: AgentToolGatewayToolName;
  input_schema: AgentToolSchema<TInput>;
  output_schema: AgentToolSchema<TOutput>;
  side_effect: AgentToolSideEffect;
  grant: AgentToolGrantRequirement;
}

export interface ReadMarketDataSnapshotToolInput {
  canonical_symbol: string;
  source?: string;
  venue?: string;
}

export interface ReadMarketDataSnapshotToolOutput {
  market: MarketRegistryEntry;
  latest_price: MarketDatum;
}

export interface BacktestRequestToolInput {
  request: BacktestRequest;
}

export interface ValidateRiskToolInput {
  intent: TradeIntent;
  policy: RiskPolicy;
  context: RiskContextInput;
}

export interface RiskContextInput {
  market_refs: string[];
  portfolio_ref?: string;
  decision_ref?: string;
}

export interface CaptureStrategyPatchProposalToolInput {
  proposal: StrategyPatchProposal;
}

export interface CaptureMemoryProposalToolInput {
  proposal: MemoryProposal;
}

export interface InspectDeploymentGateToolInput {
  gate: DeploymentGate;
}

export interface DeploymentGateInspectionOutput {
  gate_id: string;
  ready: boolean;
  missing_requirements: string[];
  required_reviews: string[];
}

const readMarketDataSnapshotInputSchema =
  schemaFromParser<ReadMarketDataSnapshotToolInput>((input) => {
    const object = record(input);
    const canonicalSymbol = CanonicalSymbolSchema.parse(object.canonical_symbol);
    const source = optionalNonEmptyString(object.source);
    const venue = optionalNonEmptyString(object.venue);
    return {
      canonical_symbol: canonicalSymbol,
      ...(source ? { source } : {}),
      ...(venue ? { venue } : {})
    };
  });

const readMarketDataSnapshotOutputSchema =
  schemaFromParser<ReadMarketDataSnapshotToolOutput>((input) => {
    const object = record(input);
    return {
      market: MarketRegistryEntrySchema.parse(object.market),
      latest_price: MarketDatumSchema.parse(object.latest_price)
    };
  });

const backtestRequestInputSchema = schemaFromParser<BacktestRequestToolInput>(
  (input) => ({
    request: BacktestRequestSchema.parse(record(input).request)
  })
);

const validateRiskInputSchema = schemaFromParser<ValidateRiskToolInput>((input) => {
  const object = record(input);
  return {
    intent: TradeIntentSchema.parse(object.intent),
    policy: RiskPolicySchema.parse(object.policy),
    context: parseRiskContext(object.context)
  };
});

const strategyPatchProposalInputSchema =
  schemaFromParser<CaptureStrategyPatchProposalToolInput>((input) => ({
    proposal: StrategyPatchProposalSchema.parse(record(input).proposal)
  }));

const memoryProposalInputSchema = schemaFromParser<CaptureMemoryProposalToolInput>(
  (input) => ({
    proposal: MemoryProposalSchema.parse(record(input).proposal)
  })
);

const inspectDeploymentGateInputSchema =
  schemaFromParser<InspectDeploymentGateToolInput>((input) => ({
    gate: DeploymentGateSchema.parse(record(input).gate)
  }));

const deploymentGateInspectionOutputSchema =
  schemaFromParser<DeploymentGateInspectionOutput>((input) => {
    const object = record(input);
    const gateId = NonEmptyStringSchema.parse(object.gate_id);
    if (typeof object.ready !== "boolean") {
      throw new Error("ready must be a boolean");
    }
    return {
      gate_id: gateId,
      ready: object.ready,
      missing_requirements: parseNonEmptyStringArray(
        object.missing_requirements,
        "missing_requirements"
      ),
      required_reviews: parseNonEmptyStringArray(
        object.required_reviews,
        "required_reviews"
      )
    };
  });

const backtestRequestOutputSchema = schemaFromParser<BacktestRequest>((input) =>
  BacktestRequestSchema.parse(input)
);

const riskReviewOutputSchema = schemaFromParser<RiskReview>((input) =>
  RiskReviewSchema.parse(input)
);

const strategyPatchProposalOutputSchema = schemaFromParser<StrategyPatchProposal>(
  (input) => StrategyPatchProposalSchema.parse(input)
);

const memoryProposalOutputSchema = schemaFromParser<MemoryProposal>((input) =>
  MemoryProposalSchema.parse(input)
);

const AGENT_TOOL_GATEWAY_TOOL_REGISTRY = {
  "market_data.read_snapshot": {
    name: "market_data.read_snapshot",
    input_schema: readMarketDataSnapshotInputSchema,
    output_schema: readMarketDataSnapshotOutputSchema,
    side_effect: "none",
    grant: {
      permission: "read",
      scope: "market_data"
    }
  },
  "backtest.request": {
    name: "backtest.request",
    input_schema: backtestRequestInputSchema,
    output_schema: backtestRequestOutputSchema,
    side_effect: "proposal_written",
    grant: {
      permission: "propose",
      scope: "backtests"
    }
  },
  "risk.validate_intent": {
    name: "risk.validate_intent",
    input_schema: validateRiskInputSchema,
    output_schema: riskReviewOutputSchema,
    side_effect: "event_logged",
    grant: {
      permission: "validate",
      scope: "risk"
    }
  },
  "strategy_patch.capture": {
    name: "strategy_patch.capture",
    input_schema: strategyPatchProposalInputSchema,
    output_schema: strategyPatchProposalOutputSchema,
    side_effect: "proposal_written",
    grant: {
      permission: "propose",
      scope: "strategy_workspace"
    }
  },
  "memory_proposal.capture": {
    name: "memory_proposal.capture",
    input_schema: memoryProposalInputSchema,
    output_schema: memoryProposalOutputSchema,
    side_effect: "proposal_written",
    grant: {
      permission: "propose",
      scope: "memory_proposals"
    }
  },
  "deployment_gate.inspect": {
    name: "deployment_gate.inspect",
    input_schema: inspectDeploymentGateInputSchema,
    output_schema: deploymentGateInspectionOutputSchema,
    side_effect: "none",
    grant: {
      permission: "inspect",
      scope: "deployment_gates"
    }
  }
} satisfies {
  [TToolName in AgentToolGatewayToolName]: AgentToolGatewayToolDefinition;
};

export function agentToolGatewayToolNames(): AgentToolGatewayToolName[] {
  return [...AGENT_TOOL_GATEWAY_TOOLS];
}

export function agentToolGatewayToolDefinition<
  TToolName extends AgentToolGatewayToolName
>(toolName: TToolName): (typeof AGENT_TOOL_GATEWAY_TOOL_REGISTRY)[TToolName] {
  return AGENT_TOOL_GATEWAY_TOOL_REGISTRY[toolName];
}

export function isAgentToolGatewayToolName(
  toolName: string
): toolName is AgentToolGatewayToolName {
  return (AGENT_TOOL_GATEWAY_TOOLS as readonly string[]).includes(toolName);
}

export function agentToolGrantAllows(
  toolName: AgentToolGatewayToolName,
  grantInput: unknown,
  options: { now?: string } = {}
): boolean {
  const grantResult = safeParseGrant(grantInput);
  if (!grantResult.success) {
    return false;
  }

  const grant = grantResult.data;
  const requirement = agentToolGatewayToolDefinition(toolName).grant;
  if (
    grant.tool_name !== toolName ||
    grant.permission !== requirement.permission ||
    grant.scope !== requirement.scope
  ) {
    return false;
  }

  if (grant.expires_at && options.now) {
    return Date.parse(grant.expires_at) >= Date.parse(options.now);
  }
  return true;
}

function schemaFromParser<T>(parse: (input: unknown) => T): AgentToolSchema<T> {
  return {
    parse,
    safeParse(input) {
      try {
        return { success: true, data: parse(input) };
      } catch (error) {
        return { success: false, error };
      }
    }
  };
}

function safeParseGrant(input: unknown): AgentToolSchemaResult<AgentToolGrant> {
  try {
    return { success: true, data: AgentToolGrantSchema.parse(input) };
  } catch (error) {
    return { success: false, error };
  }
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  throw new Error("tool input must be an object");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return NonEmptyStringSchema.parse(value);
}

function parseRiskContext(input: unknown): RiskContextInput {
  const object = record(input);
  const marketRefs = parseSourceRefArray(object.market_refs, "market_refs");
  const portfolioRef = optionalSourceRef(object.portfolio_ref);
  const decisionRef = optionalSourceRef(object.decision_ref);
  return {
    market_refs: marketRefs,
    ...(portfolioRef ? { portfolio_ref: portfolioRef } : {}),
    ...(decisionRef ? { decision_ref: decisionRef } : {})
  };
}

function optionalSourceRef(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return SourceRefSchema.parse(value);
}

function parseSourceRefArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item) => SourceRefSchema.parse(item));
}

function parseNonEmptyStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item) => NonEmptyStringSchema.parse(item));
}
