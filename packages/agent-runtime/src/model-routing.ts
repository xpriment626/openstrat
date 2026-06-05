import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const IN_MEMORY_AUTH = new WeakSet<AuthStorage>();

export const OpenStratModelAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("byok"),
    provider: z.string().trim().min(1)
  }),
  z.object({
    kind: z.literal("openai_codex_oauth"),
    provider: z.literal("openai")
  })
]);

export const OpenStratModelProfileSchema = z.object({
  id: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  auth: OpenStratModelAuthSchema
});

export type OpenStratModelAuth = z.infer<typeof OpenStratModelAuthSchema>;
export type OpenStratModelProfile = z.infer<typeof OpenStratModelProfileSchema>;
export type OpenStratPiAuthData = Parameters<typeof AuthStorage.inMemory>[0];

export type OpenStratResolvedModelProfile =
  | {
      ok: true;
      id: string;
      provider: string;
      model: string;
      model_available: boolean;
      auth_source: string;
      oauth: boolean;
      secret_persisted: boolean;
      api_key_preview: string;
    }
  | {
      ok: false;
      id: string;
      provider: string;
      model: string;
      error: "missing_auth" | "invalid_profile";
      secret_persisted: boolean;
    };

export interface OpenStratModelRouter {
  resolveProfile(profile: unknown): Promise<OpenStratResolvedModelProfile>;
}

export interface OpenStratModelRouterOptions {
  auth: AuthStorage;
  modelRegistry?: ModelRegistry;
}

export function createInMemoryPiModelAuth(data?: OpenStratPiAuthData): AuthStorage {
  const auth = AuthStorage.inMemory(data);
  IN_MEMORY_AUTH.add(auth);
  return auth;
}

export function createOpenStratModelRouter(
  options: OpenStratModelRouterOptions
): OpenStratModelRouter {
  const modelRegistry = options.modelRegistry ?? ModelRegistry.inMemory(options.auth);

  return {
    async resolveProfile(profileInput) {
      const parsed = OpenStratModelProfileSchema.safeParse(profileInput);
      if (!parsed.success) {
        return {
          ok: false,
          id: "invalid",
          provider: "invalid",
          model: "invalid",
          error: "invalid_profile",
          secret_persisted: !IN_MEMORY_AUTH.has(options.auth)
        };
      }

      const profile = parsed.data;
      const provider = profile.auth.provider;
      const credential = options.auth.get(provider);
      const apiKey = await resolveProfileSecret(options.auth, profile);

      if (!apiKey) {
        return {
          ok: false,
          id: profile.id,
          provider,
          model: profile.model,
          error: "missing_auth",
          secret_persisted: !IN_MEMORY_AUTH.has(options.auth)
        };
      }

      const authStatus = options.auth.getAuthStatus(provider);
      const model = modelRegistry.find(profile.provider, profile.model);

      return {
        ok: true,
        id: profile.id,
        provider,
        model: profile.model,
        model_available: model !== undefined,
        auth_source: authStatus.source ?? (credential ? "stored" : "runtime"),
        oauth:
          credential?.type === "oauth" || profile.auth.kind === "openai_codex_oauth",
        secret_persisted: !IN_MEMORY_AUTH.has(options.auth),
        api_key_preview: previewSecret(apiKey)
      };
    }
  };
}

async function resolveProfileSecret(
  auth: AuthStorage,
  profile: OpenStratModelProfile
): Promise<string | undefined> {
  const provider = profile.auth.provider;
  const apiKey = await auth.getApiKey(provider);
  if (apiKey) {
    return apiKey;
  }

  const credential = auth.get(provider);
  if (credential?.type === "oauth") {
    return credential.access;
  }
  return undefined;
}

function previewSecret(secret: string): string {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
