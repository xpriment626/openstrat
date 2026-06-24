import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

export const CodexIntegrationModeSchema = z.enum([
  "sdk",
  "app_server_stdio",
  "app_server_websocket",
  "app_server_unix_socket"
]);

export const CodexAuthModeSchema = z.enum(["chatgpt", "api_key", "access_token"]);

export const CodexSandboxModeSchema = z.enum([
  "read_only",
  "workspace_write",
  "full_access"
]);

export const CodexApprovalPolicySchema = z.enum([
  "untrusted",
  "on_request",
  "on_failure",
  "never"
]);

export const CodexOwnedCapabilitySchema = z.enum([
  "auth",
  "model_selection",
  "conversation_threads",
  "turn_execution",
  "streaming_events",
  "native_file_tools",
  "native_shell_tools",
  "sandboxing",
  "approval_prompts",
  "session_resume",
  "session_fork",
  "compaction"
]);

export const OpenStratOwnedCapabilitySchema = z.enum([
  "project_config",
  "user_config",
  "market_data",
  "dataset_provenance",
  "strategy_workspace",
  "strategy_validation",
  "backtesting",
  "risk_policy",
  "deployment_gates",
  "artifact_index",
  "decision_memory",
  "builder_code_config",
  "wallet_handle_config"
]);

export const OpenStratCodexToolSideEffectSchema = z.enum([
  "none",
  "external_read",
  "project_artifact_write",
  "project_state_write",
  "external_write_blocked"
]);

export const OpenStratCodexToolDefinitionSchema = z
  .object({
    name: NonEmptyStringSchema,
    capability: OpenStratOwnedCapabilitySchema,
    side_effect: OpenStratCodexToolSideEffectSchema,
    codex_native_tool: z.literal(false).default(false),
    requires_human_approval: z.boolean().default(false),
    output_artifact_kinds: z.array(NonEmptyStringSchema).default([])
  })
  .superRefine((tool, ctx) => {
    if (tool.side_effect === "external_write_blocked" && tool.requires_human_approval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blocked external writes must not be approval-enabled tools",
        path: ["requires_human_approval"]
      });
    }
  });

export const OpenStratConfigScopeItemSchema = z.enum([
  "builder_codes",
  "default_venue",
  "market_data_cache_policy",
  "project_dataset_index",
  "strategy_workspace_policy",
  "wallet_handles"
]);

export const OpenStratForbiddenSecretClassSchema = z.enum([
  "codex_tokens",
  "exchange_api_secrets",
  "private_keys",
  "seed_phrases",
  "wallet_signing_keys"
]);

export const CodexOpenStratConfigBoundarySchema = z.object({
  codex_home_env: z.literal("CODEX_HOME").default("CODEX_HOME"),
  openstrat_user_home_env: z
    .literal("OPENSTRAT_USER_HOME")
    .default("OPENSTRAT_USER_HOME"),
  project_dir: z.literal(".openstrat").default(".openstrat"),
  project_scope: z.array(OpenStratConfigScopeItemSchema).min(1),
  user_scope: z.array(OpenStratConfigScopeItemSchema).min(1),
  forbidden_openstrat_secret_classes: z
    .array(OpenStratForbiddenSecretClassSchema)
    .min(1),
  secret_material_policy: z
    .literal("owned_by_codex_or_wallet_provider")
    .default("owned_by_codex_or_wallet_provider")
});

export const CodexBaselineContractSchema = z
  .object({
    schema_version: z.literal("2026-06-22"),
    runtime: z.object({
      integration_mode: CodexIntegrationModeSchema,
      auth_modes: z.array(CodexAuthModeSchema).min(1),
      default_sandbox_mode: CodexSandboxModeSchema,
      default_approval_policy: CodexApprovalPolicySchema
    }),
    codex_owns: z.array(CodexOwnedCapabilitySchema).min(1),
    openstrat_owns: z.array(OpenStratOwnedCapabilitySchema).min(1),
    openstrat_tools: z.array(OpenStratCodexToolDefinitionSchema).min(1),
    config_boundary: CodexOpenStratConfigBoundarySchema,
    non_goals: z.array(
      z.enum([
        "custom_tui",
        "wallet_signing",
        "cloud_deployment",
        "pi_runtime",
        "openclaw_compat",
        "strategy_quality_tuning"
      ])
    )
  })
  .superRefine((contract, ctx) => {
    for (const capability of requiredCodexCapabilities) {
      if (!contract.codex_owns.includes(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Codex baseline must assign ${capability} to Codex`,
          path: ["codex_owns"]
        });
      }
    }

    for (const capability of requiredOpenStratCapabilities) {
      if (!contract.openstrat_owns.includes(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Codex baseline must assign ${capability} to OpenStrat`,
          path: ["openstrat_owns"]
        });
      }
    }
  });

const requiredCodexCapabilities: z.infer<typeof CodexOwnedCapabilitySchema>[] = [
  "auth",
  "conversation_threads",
  "turn_execution",
  "streaming_events",
  "native_file_tools",
  "native_shell_tools",
  "sandboxing",
  "approval_prompts",
  "session_resume",
  "compaction"
];

const requiredOpenStratCapabilities: z.infer<typeof OpenStratOwnedCapabilitySchema>[] =
  [
    "project_config",
    "user_config",
    "market_data",
    "dataset_provenance",
    "strategy_workspace",
    "strategy_validation",
    "backtesting",
    "risk_policy",
    "deployment_gates",
    "artifact_index",
    "builder_code_config",
    "wallet_handle_config"
  ];

export const OPENSTRAT_CODEX_BASELINE_CONTRACT = {
  schema_version: "2026-06-22",
  runtime: {
    integration_mode: "sdk",
    auth_modes: ["chatgpt", "api_key"],
    default_sandbox_mode: "workspace_write",
    default_approval_policy: "on_request"
  },
  codex_owns: [
    "auth",
    "model_selection",
    "conversation_threads",
    "turn_execution",
    "streaming_events",
    "native_file_tools",
    "native_shell_tools",
    "sandboxing",
    "approval_prompts",
    "session_resume",
    "session_fork",
    "compaction"
  ],
  openstrat_owns: [
    "project_config",
    "user_config",
    "market_data",
    "dataset_provenance",
    "strategy_workspace",
    "strategy_validation",
    "backtesting",
    "risk_policy",
    "deployment_gates",
    "artifact_index",
    "decision_memory",
    "builder_code_config",
    "wallet_handle_config"
  ],
  openstrat_tools: [
    {
      name: "market_data.read_snapshot",
      capability: "market_data",
      side_effect: "external_read",
      output_artifact_kinds: ["market_snapshot"]
    },
    {
      name: "dataset.plan_ingestion",
      capability: "dataset_provenance",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["dataset_ingestion_plan"]
    },
    {
      name: "dataset.execute_ingestion",
      capability: "market_data",
      side_effect: "external_read",
      requires_human_approval: true,
      output_artifact_kinds: ["dataset_ingest_result"]
    },
    {
      name: "dataset.validate",
      capability: "dataset_provenance",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["dataset_validation"]
    },
    {
      name: "dataset.inspect",
      capability: "dataset_provenance",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["dataset_inspection"]
    },
    {
      name: "strategy.guide",
      capability: "strategy_workspace",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["strategy_authoring_guide"]
    },
    {
      name: "strategy.validate",
      capability: "strategy_validation",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["strategy_validation"]
    },
    {
      name: "backtest.plan",
      capability: "backtesting",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["backtest_plan"]
    },
    {
      name: "backtest.run",
      capability: "backtesting",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["backtest_report"]
    },
    {
      name: "backtest.request",
      capability: "backtesting",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["backtest_request"]
    },
    {
      name: "risk.preflight",
      capability: "risk_policy",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["risk_preflight"]
    },
    {
      name: "risk.validate_intent",
      capability: "risk_policy",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["risk_review"]
    },
    {
      name: "strategy_patch.capture",
      capability: "strategy_workspace",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["strategy_patch"]
    },
    {
      name: "memory_proposal.capture",
      capability: "decision_memory",
      side_effect: "project_artifact_write",
      output_artifact_kinds: ["memory_proposal"]
    },
    {
      name: "deployment_gate.inspect",
      capability: "deployment_gates",
      side_effect: "none",
      output_artifact_kinds: ["deployment_gate_inspection"]
    }
  ],
  config_boundary: {
    project_scope: [
      "builder_codes",
      "default_venue",
      "project_dataset_index",
      "strategy_workspace_policy",
      "wallet_handles"
    ],
    user_scope: [
      "builder_codes",
      "default_venue",
      "market_data_cache_policy",
      "wallet_handles"
    ],
    forbidden_openstrat_secret_classes: [
      "codex_tokens",
      "exchange_api_secrets",
      "private_keys",
      "seed_phrases",
      "wallet_signing_keys"
    ]
  },
  non_goals: [
    "custom_tui",
    "wallet_signing",
    "cloud_deployment",
    "pi_runtime",
    "openclaw_compat",
    "strategy_quality_tuning"
  ]
} as const;

export type CodexIntegrationMode = z.infer<typeof CodexIntegrationModeSchema>;
export type CodexAuthMode = z.infer<typeof CodexAuthModeSchema>;
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;
export type CodexOwnedCapability = z.infer<typeof CodexOwnedCapabilitySchema>;
export type OpenStratOwnedCapability = z.infer<typeof OpenStratOwnedCapabilitySchema>;
export type OpenStratCodexToolSideEffect = z.infer<
  typeof OpenStratCodexToolSideEffectSchema
>;
export type OpenStratCodexToolDefinition = z.infer<
  typeof OpenStratCodexToolDefinitionSchema
>;
export type OpenStratConfigScopeItem = z.infer<typeof OpenStratConfigScopeItemSchema>;
export type OpenStratForbiddenSecretClass = z.infer<
  typeof OpenStratForbiddenSecretClassSchema
>;
export type CodexOpenStratConfigBoundary = z.infer<
  typeof CodexOpenStratConfigBoundarySchema
>;
export type CodexBaselineContract = z.infer<typeof CodexBaselineContractSchema>;
