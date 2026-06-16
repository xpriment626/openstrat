import {
  ObjectRefSchema,
  StrategyPatchProposalSchema,
  type StrategyPatchProposal
} from "@openstrat/domain";
import type { EventLogRepository, ObjectStore } from "@openstrat/persistence";

export class NativeMutationBlockedError extends Error {
  constructor(toolName: string, targetRef: string) {
    super(
      `Native mutation tool is not allowed to write canonical harness state: ${toolName} -> ${targetRef}`
    );
    this.name = "NativeMutationBlockedError";
  }
}

export interface StrategyProposalWorkflowDependencies {
  events: EventLogRepository;
  object_ref_root?: string;
  objects: ObjectStore;
  now?: () => string;
}

export interface StrategyProposalFile {
  path: string;
  content: string;
}

export interface NativeMutationRequest {
  tool_name: string;
  target_ref: string;
}

export interface CaptureStrategyPatchBundleInput {
  session_id: string;
  turn_id: string;
  strategy_id: string;
  base_strategy_version?: string;
  rationale: string;
  files: readonly StrategyProposalFile[];
  native_mutation?: NativeMutationRequest;
}

export interface StrategyProposalWorkflow {
  capturePatchBundle(input: CaptureStrategyPatchBundleInput): StrategyPatchProposal;
}

export function createStrategyProposalWorkflow(
  dependencies: StrategyProposalWorkflowDependencies
): StrategyProposalWorkflow {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const objectRefRoot = dependencies.object_ref_root
    ? objectRefRootFor(dependencies.object_ref_root)
    : undefined;

  return {
    capturePatchBundle(input) {
      if (input.native_mutation) {
        recordNativeMutationBlocked(dependencies, now(), input);
        throw new NativeMutationBlockedError(
          input.native_mutation.tool_name,
          input.native_mutation.target_ref
        );
      }

      const createdAt = now();
      const proposalId = proposalIdFor(input);
      const patchRef = prefixObjectRef(
        objectRefRoot,
        `scratch/${sanitizeRefSegment(
          input.session_id
        )}/strategy-patches/${proposalId}.bundle.json`
      );
      const testsRef = containsTestFile(input.files) ? `${patchRef}#tests` : undefined;
      const artifactRef = {
        id: `${proposalId}_artifact`,
        kind: "proposal",
        uri: prefixObjectRef(
          objectRefRoot,
          `agent-artifacts/${sanitizeRefSegment(input.session_id)}/${proposalId}.json`
        ),
        content_hash: `sha256:${proposalId}`,
        created_at: createdAt,
        append_only: true,
        metadata: {
          patch_ref: patchRef,
          strategy_id: input.strategy_id
        }
      };

      const patchBundle = {
        id: proposalId,
        created_at: createdAt,
        session_id: input.session_id,
        turn_id: input.turn_id,
        strategy_id: input.strategy_id,
        base_strategy_version: input.base_strategy_version,
        rationale: input.rationale,
        files: input.files.map((file) => ({
          path: file.path,
          content: file.content
        }))
      };

      dependencies.objects.putJson(patchRef, patchBundle);

      const proposal = StrategyPatchProposalSchema.parse({
        id: proposalId,
        created_at: createdAt,
        session_id: input.session_id,
        turn_id: input.turn_id,
        status: "proposed",
        artifact_ref: artifactRef,
        strategy_id: input.strategy_id,
        base_strategy_version: input.base_strategy_version,
        patch_format: "file_bundle",
        patch_ref: patchRef,
        rationale: input.rationale,
        ...(testsRef ? { tests_ref: testsRef } : {})
      });

      dependencies.objects.putJson(proposal.artifact_ref.uri, proposal);
      dependencies.events.append({
        stream_id: streamId(input.session_id),
        type: "agent.strategy_patch.proposed",
        occurred_at: createdAt,
        payload: {
          proposal_id: proposal.id,
          strategy_id: proposal.strategy_id,
          patch_ref: proposal.patch_ref,
          artifact_ref: proposal.artifact_ref.uri,
          patch_format: proposal.patch_format
        }
      });

      return proposal;
    }
  };
}

function recordNativeMutationBlocked(
  dependencies: StrategyProposalWorkflowDependencies,
  occurredAt: string,
  input: CaptureStrategyPatchBundleInput
): void {
  if (!input.native_mutation) {
    return;
  }

  dependencies.events.append({
    stream_id: streamId(input.session_id),
    type: "agent.strategy_patch.native_mutation_blocked",
    occurred_at: occurredAt,
    payload: {
      strategy_id: input.strategy_id,
      tool_name: input.native_mutation.tool_name,
      target_ref: input.native_mutation.target_ref,
      reason: "strategy proposals must be captured as scratch artifacts"
    }
  });
}

function proposalIdFor(input: CaptureStrategyPatchBundleInput): string {
  return [
    "strategy_patch",
    input.session_id,
    input.turn_id,
    input.strategy_id,
    input.base_strategy_version ?? "unversioned"
  ]
    .map(sanitizeRefSegment)
    .join("_");
}

function containsTestFile(files: readonly StrategyProposalFile[]): boolean {
  return files.some((file) =>
    /(^|\/)[^/]*(\.test|\.spec)\.[cm]?[jt]sx?$/.test(file.path)
  );
}

function sanitizeRefSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function streamId(sessionId: string): string {
  return `agent_sessions/${sessionId}`;
}

function objectRefRootFor(root: string): string {
  const parsed = ObjectRefSchema.parse(root.replace(/\/+$/u, ""));
  if (parsed.startsWith("agent-artifacts/") || parsed.startsWith("scratch/")) {
    throw new Error(`Object ref root must not be a proposal root: ${root}`);
  }
  return parsed;
}

function prefixObjectRef(root: string | undefined, ref: string): string {
  return root ? `${root}/${ref}` : ref;
}
