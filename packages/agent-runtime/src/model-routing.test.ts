import { describe, expect, it } from "vitest";
import {
  createInMemoryPiModelAuth,
  createOpenStratModelRouter,
  OpenStratModelProfileSchema
} from "./model-routing.js";

describe("OpenStrat Pi model routing", () => {
  it("validates BYOK and OpenAI Codex OAuth model profile contracts", () => {
    expect(
      OpenStratModelProfileSchema.safeParse({
        id: "model/anthropic-sonnet",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        auth: {
          kind: "byok",
          provider: "anthropic"
        }
      }).success
    ).toBe(true);

    expect(
      OpenStratModelProfileSchema.safeParse({
        id: "model/openai-codex-subscription",
        provider: "openai",
        model: "gpt-5.5",
        auth: {
          kind: "openai_codex_oauth",
          provider: "openai"
        }
      }).success
    ).toBe(true);
  });

  it("uses runtime BYOK credentials without persisting secrets to files", async () => {
    const auth = createInMemoryPiModelAuth();
    const router = createOpenStratModelRouter({ auth });

    auth.setRuntimeApiKey("anthropic", "sk-test-runtime");

    const result = await router.resolveProfile({
      id: "model/anthropic-sonnet",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      auth: {
        kind: "byok",
        provider: "anthropic"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.auth_source).toBe("runtime");
    expect(result.secret_persisted).toBe(false);
    expect(result.api_key_preview).toBe("sk-t...time");
  });

  it("fails closed when a model profile has no configured credentials", async () => {
    const router = createOpenStratModelRouter({
      auth: createInMemoryPiModelAuth()
    });

    const result = await router.resolveProfile({
      id: "model/missing-openai",
      provider: "openai",
      model: "gpt-5.5",
      auth: {
        kind: "openai_codex_oauth",
        provider: "openai"
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: "missing_auth",
      provider: "openai"
    });
  });

  it("recognizes in-memory OpenAI Codex OAuth credentials without exposing tokens", async () => {
    const auth = createInMemoryPiModelAuth({
      openai: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000
      }
    });
    const router = createOpenStratModelRouter({ auth });

    const result = await router.resolveProfile({
      id: "model/openai-codex-subscription",
      provider: "openai",
      model: "gpt-5.5",
      auth: {
        kind: "openai_codex_oauth",
        provider: "openai"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.oauth).toBe(true);
    expect(result.secret_persisted).toBe(false);
    expect(result.api_key_preview).toBe("acce...oken");
  });
});
