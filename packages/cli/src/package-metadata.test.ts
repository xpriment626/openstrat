import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("publishable CLI package metadata", () => {
  it("keeps the root private package separate from the public openstrat CLI", () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8")
    ) as {
      name: string;
      private: boolean;
    };
    const cliPackage = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf8")
    ) as {
      name: string;
      private?: boolean;
      bin?: Record<string, string>;
      files?: string[];
    };

    expect(rootPackage).toMatchObject({
      name: "openstrat-monorepo",
      private: true
    });
    expect(cliPackage.name).toBe("openstrat");
    expect(cliPackage.private).not.toBe(true);
    expect(cliPackage.bin).toEqual({
      openstrat: "./dist/openstrat"
    });
    expect(cliPackage.files).toEqual(
      expect.arrayContaining([
        "dist/openstrat",
        "dist/index.js",
        "dist/**/*.d.ts",
        "package.json",
        "README.md"
      ])
    );
    expect(cliPackage.files).not.toEqual(
      expect.arrayContaining(["dist", "src", "test", "tests", "docs", "AGENTS.md"])
    );
  });
});
