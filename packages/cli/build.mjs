import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
  external: [
    "@modelcontextprotocol/sdk/*",
    "@openai/codex",
    "@openai/codex-sdk",
    "esbuild",
    "zod"
  ],
  format: "esm",
  outfile: "dist/index.js",
  platform: "node",
  sourcemap: true,
  target: "node22"
});

const binPath = join("dist", "openstrat");
writeFileSync(
  binPath,
  `#!/usr/bin/env node
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const message =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : "";
  const type = typeof args[0] === "string" ? args[0] : undefined;
  if (
    type === "ExperimentalWarning" &&
    message.includes("SQLite is an experimental feature")
  ) {
    return;
  }
  return emitWarning(warning, ...args);
};
const { runProcessCli } = await import("./index.js");
await runProcessCli();
`,
  "utf8"
);
chmodSync(binPath, 0o755);
