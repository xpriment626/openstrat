import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NonEmptyStringSchema = z.string().trim().min(1);
export const CanonicalSymbolSchema = NonEmptyStringSchema.regex(
  /^[A-Z0-9][A-Z0-9._:/-]*$/,
  "Canonical symbols should be stable uppercase identifiers"
);
export const SourceRefSchema = NonEmptyStringSchema;
export const ObjectRefSchema = NonEmptyStringSchema.refine(
  isSafeObjectRef,
  "object refs must be relative POSIX paths within the object store"
);
export const AppendOnlyObjectRefSchema = ObjectRefSchema;
export const ProposalObjectRefSchema = ObjectRefSchema.refine(
  isProposalObjectRef,
  "proposal refs must live under agent-artifacts/ or scratch/"
);
export const CanonicalObjectRefSchema = ObjectRefSchema.refine(
  isCanonicalObjectRef,
  "canonical refs must not live under proposal or scratch storage"
);
export const JsonRecordSchema = z.record(z.string(), z.unknown());
export const NonNegativeFiniteSchema = z.number().finite().min(0);
export const PositiveFiniteSchema = z.number().finite().positive();
export const RatioSchema = z.number().finite().min(0).max(1);
export const PercentSchema = z.number().finite().min(0).max(100);
export const BasisPointsSchema = z.number().finite().min(0).max(10_000);

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export const AutonomyModeSchema = z.enum([
  "research_only",
  "strategy_workbench",
  "paper_trading",
  "draft_orders",
  "constrained_live",
  "adaptive_management"
]);

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type ObjectRef = z.infer<typeof ObjectRefSchema>;
export type AppendOnlyObjectRef = z.infer<typeof AppendOnlyObjectRefSchema>;
export type ProposalObjectRef = z.infer<typeof ProposalObjectRefSchema>;
export type CanonicalObjectRef = z.infer<typeof CanonicalObjectRefSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

const PROPOSAL_OBJECT_REF_PREFIXES = ["agent-artifacts/", "scratch/"] as const;

export function isObjectRef(value: string): boolean {
  return isSafeObjectRef(value);
}

export function isProposalObjectRef(value: string): boolean {
  return (
    isSafeObjectRef(value) &&
    (PROPOSAL_OBJECT_REF_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
      isProjectScopedProposalObjectRef(value))
  );
}

export function isCanonicalObjectRef(value: string): boolean {
  return isSafeObjectRef(value) && !isProposalObjectRef(value);
}

function isSafeObjectRef(value: string): boolean {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function isProjectScopedProposalObjectRef(value: string): boolean {
  const segments = value.split("/");
  return (
    segments[0] === "projects" &&
    (segments[2] === "agent-artifacts" || segments[2] === "scratch") &&
    segments.length > 3
  );
}
