import {
  AgentToolCallRecordSchema,
  BacktestRequestSchema,
  DeploymentGateSchema,
  MemoryProposalSchema,
  RiskPolicySchema,
  StrategyPatchProposalSchema,
  TradeIntentSchema,
  type BacktestRequest,
  type DeploymentGate,
  type MemoryProposal,
  type RiskPolicy,
  type RiskReview,
  type StrategyPatchProposal,
  type TradeIntent
} from "@openstrat/domain";
import type { MarketDataReader } from "@openstrat/market-data";
import type { EventLogRepository, ObjectStore } from "@openstrat/persistence";
import type { RiskContext, RiskPolicyEngine } from "@openstrat/risk";

export const AGENT_TOOL_GATEWAY_TOOLS = [
  "market_data.read_snapshot",
  "backtest.request",
  "risk.validate_intent",
  "strategy_patch.capture",
  "memory_proposal.capture",
  "deployment_gate.inspect"
] as const;

export type AgentToolGatewayToolName = (typeof AGENT_TOOL_GATEWAY_TOOLS)[number];

export interface AgentToolGatewayDependencies {
  events: EventLogRepository;
  marketData: MarketDataReader;
  objects: ObjectStore;
  risk: RiskPolicyEngine;
  now?: () => string;
}

export interface AgentToolInvocationBase {
  call_id: string;
  session_id: string;
  turn_id: string;
}

export interface ReadMarketDataSnapshotInput extends AgentToolInvocationBase {
  canonical_symbol: string;
  source?: string;
  venue?: string;
}

export interface CaptureBacktestRequestInput extends AgentToolInvocationBase {
  request: BacktestRequest;
}

export interface ValidateRiskInput extends AgentToolInvocationBase {
  intent: TradeIntent;
  policy: RiskPolicy;
  context: RiskContext;
}

export interface CaptureStrategyPatchProposalInput extends AgentToolInvocationBase {
  proposal: StrategyPatchProposal;
}

export interface CaptureMemoryProposalInput extends AgentToolInvocationBase {
  proposal: MemoryProposal;
}

export interface InspectDeploymentGateInput extends AgentToolInvocationBase {
  gate: DeploymentGate;
}

export interface DeploymentGateInspection {
  gate_id: string;
  ready: boolean;
  missing_requirements: string[];
  required_reviews: string[];
}

export interface InvokeAgentToolInput extends AgentToolInvocationBase {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolGateway {
  readonly tool_names: readonly AgentToolGatewayToolName[];
  readMarketDataSnapshot(input: ReadMarketDataSnapshotInput): Promise<{
    market: NonNullable<Awaited<ReturnType<MarketDataReader["getMarket"]>>>;
    latest_price: Awaited<ReturnType<MarketDataReader["getLatestPrice"]>>;
  }>;
  captureBacktestRequest(input: CaptureBacktestRequestInput): Promise<BacktestRequest>;
  validateRisk(input: ValidateRiskInput): Promise<RiskReview>;
  captureStrategyPatchProposal(
    input: CaptureStrategyPatchProposalInput
  ): Promise<StrategyPatchProposal>;
  captureMemoryProposal(input: CaptureMemoryProposalInput): Promise<MemoryProposal>;
  inspectDeploymentGate(
    input: InspectDeploymentGateInput
  ): Promise<DeploymentGateInspection>;
  invoke(input: InvokeAgentToolInput): Promise<unknown>;
}

export function createAgentToolGateway(
  dependencies: AgentToolGatewayDependencies
): AgentToolGateway {
  const now = dependencies.now ?? (() => new Date().toISOString());

  const gateway: AgentToolGateway = {
    tool_names: AGENT_TOOL_GATEWAY_TOOLS,

    async readMarketDataSnapshot(input) {
      const market = await dependencies.marketData.getMarket(input.canonical_symbol);
      if (!market) {
        recordToolFailure(dependencies, now(), input, "market_data.read_snapshot", {
          error: `market not found: ${input.canonical_symbol}`
        });
        throw new Error(`market not found: ${input.canonical_symbol}`);
      }

      const latestPrice = await dependencies.marketData.getLatestPrice({
        canonical_symbol: input.canonical_symbol,
        ...(input.source ? { source: input.source } : {}),
        ...(input.venue ? { venue: input.venue } : {})
      });

      recordToolCompleted(dependencies, now(), input, "market_data.read_snapshot", {
        side_effect: "none",
        result_ref: latestPrice.raw_ref ?? market.source_refs[0]
      });
      return { market, latest_price: latestPrice };
    },

    async captureBacktestRequest(input) {
      const request = BacktestRequestSchema.parse(input.request);
      writeProposalArtifact(dependencies.objects, request.artifact_ref.uri, request);
      recordProposalCaptured(dependencies, now(), input, "backtest.request", request);
      recordToolCompleted(dependencies, now(), input, "backtest.request", {
        side_effect: "proposal_written",
        result_ref: request.artifact_ref.uri
      });
      return request;
    },

    async validateRisk(input) {
      const intent = TradeIntentSchema.parse(input.intent);
      const policy = RiskPolicySchema.parse(input.policy);
      const review = await dependencies.risk.review(intent, policy, input.context);
      recordToolCompleted(dependencies, now(), input, "risk.validate_intent", {
        side_effect: "event_logged",
        result_ref: review.id,
        status: review.status
      });
      return review;
    },

    async captureStrategyPatchProposal(input) {
      const proposal = StrategyPatchProposalSchema.parse(input.proposal);
      writeProposalArtifact(dependencies.objects, proposal.artifact_ref.uri, proposal);
      recordProposalCaptured(
        dependencies,
        now(),
        input,
        "strategy_patch.capture",
        proposal
      );
      recordToolCompleted(dependencies, now(), input, "strategy_patch.capture", {
        side_effect: "proposal_written",
        result_ref: proposal.artifact_ref.uri
      });
      return proposal;
    },

    async captureMemoryProposal(input) {
      const proposal = MemoryProposalSchema.parse(input.proposal);
      writeProposalArtifact(dependencies.objects, proposal.artifact_ref.uri, proposal);
      recordProposalCaptured(
        dependencies,
        now(),
        input,
        "memory_proposal.capture",
        proposal
      );
      recordToolCompleted(dependencies, now(), input, "memory_proposal.capture", {
        side_effect: "proposal_written",
        result_ref: proposal.artifact_ref.uri
      });
      return proposal;
    },

    async inspectDeploymentGate(input) {
      const gate = DeploymentGateSchema.parse(input.gate);
      const missingRequirements = inspectGateMissingRequirements(gate);
      const inspection: DeploymentGateInspection = {
        gate_id: gate.id,
        ready: missingRequirements.length === 0,
        missing_requirements: missingRequirements,
        required_reviews: gate.required_reviews
      };
      recordToolCompleted(dependencies, now(), input, "deployment_gate.inspect", {
        side_effect: "none",
        result_ref: gate.id,
        ready: inspection.ready
      });
      return inspection;
    },

    async invoke(input) {
      if (!isSupportedTool(input.tool_name)) {
        recordToolBlocked(dependencies, now(), input, input.tool_name, {
          reason: `tool is not available through the harness-owned agent gateway`
        });
        throw new Error(`tool is not available: ${input.tool_name}`);
      }

      throw new Error(
        `direct invocation for ${input.tool_name} requires the typed gateway method`
      );
    }
  };

  return gateway;
}

function writeProposalArtifact(
  objects: ObjectStore,
  ref: string,
  value: unknown
): void {
  objects.putJson(ref, value);
}

function inspectGateMissingRequirements(gate: DeploymentGate): string[] {
  const missing: string[] = [];
  if (!gate.backtest.include_fees) {
    missing.push("fee-inclusive backtest required");
  }
  if (!gate.backtest.include_slippage_model) {
    missing.push("slippage-model backtest required");
  }
  if (!gate.required_reviews.includes("risk")) {
    missing.push("risk review required");
  }
  if (gate.deployment.kill_switch) {
    missing.push("deployment kill switch is active");
  }
  return missing;
}

function isSupportedTool(toolName: string): toolName is AgentToolGatewayToolName {
  return AGENT_TOOL_GATEWAY_TOOLS.includes(toolName as AgentToolGatewayToolName);
}

function recordProposalCaptured(
  dependencies: AgentToolGatewayDependencies,
  occurredAt: string,
  input: AgentToolInvocationBase,
  toolName: AgentToolGatewayToolName,
  proposal: { id: string; artifact_ref: { uri: string }; status: string }
): void {
  dependencies.events.append({
    stream_id: streamId(input.session_id),
    type: "agent.proposal.captured",
    occurred_at: occurredAt,
    payload: {
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      artifact_ref: proposal.artifact_ref.uri,
      tool_name: toolName
    }
  });
}

function recordToolCompleted(
  dependencies: AgentToolGatewayDependencies,
  occurredAt: string,
  input: AgentToolInvocationBase,
  toolName: AgentToolGatewayToolName,
  payload: Record<string, unknown> & {
    side_effect:
      | "none"
      | "event_logged"
      | "proposal_written"
      | "scratch_workspace_write";
  }
): void {
  const record = AgentToolCallRecordSchema.parse({
    id: input.call_id,
    session_id: input.session_id,
    turn_id: input.turn_id,
    tool_name: toolName,
    arguments: {},
    status: "completed",
    requested_at: occurredAt,
    completed_at: occurredAt,
    output_ref:
      typeof payload.result_ref === "string"
        ? payload.result_ref
        : `${toolName}:${input.call_id}`,
    side_effect: payload.side_effect
  });

  dependencies.events.append({
    stream_id: streamId(input.session_id),
    type: "agent.tool_call.completed",
    occurred_at: occurredAt,
    payload: {
      ...payload,
      tool_call: record,
      tool_call_id: input.call_id,
      tool_name: toolName
    }
  });
}

function recordToolFailure(
  dependencies: AgentToolGatewayDependencies,
  occurredAt: string,
  input: AgentToolInvocationBase,
  toolName: AgentToolGatewayToolName,
  payload: Record<string, unknown>
): void {
  const record = AgentToolCallRecordSchema.parse({
    id: input.call_id,
    session_id: input.session_id,
    turn_id: input.turn_id,
    tool_name: toolName,
    arguments: {},
    status: "failed",
    requested_at: occurredAt,
    completed_at: occurredAt,
    error: typeof payload.error === "string" ? payload.error : "tool failed",
    side_effect: "none"
  });

  dependencies.events.append({
    stream_id: streamId(input.session_id),
    type: "agent.tool_call.failed",
    occurred_at: occurredAt,
    payload: {
      ...payload,
      tool_call: record,
      tool_call_id: input.call_id,
      tool_name: toolName,
      side_effect: "none"
    }
  });
}

function recordToolBlocked(
  dependencies: AgentToolGatewayDependencies,
  occurredAt: string,
  input: AgentToolInvocationBase,
  toolName: string,
  payload: Record<string, unknown>
): void {
  const record = AgentToolCallRecordSchema.parse({
    id: input.call_id,
    session_id: input.session_id,
    turn_id: input.turn_id,
    tool_name: toolName,
    arguments: {},
    status: "blocked",
    requested_at: occurredAt,
    completed_at: occurredAt,
    error: typeof payload.reason === "string" ? payload.reason : "tool blocked",
    side_effect: "none"
  });

  dependencies.events.append({
    stream_id: streamId(input.session_id),
    type: "agent.tool_call.blocked",
    occurred_at: occurredAt,
    payload: {
      ...payload,
      tool_call: record,
      tool_call_id: input.call_id,
      tool_name: toolName,
      side_effect: "none"
    }
  });
}

function streamId(sessionId: string): string {
  return `agent_sessions/${sessionId}`;
}
