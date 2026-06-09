import { build } from "esbuild";
import { chmodSync } from "node:fs";

const outfile = "dist/index.js";

await build({
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  entryPoints: ["src/index.ts"],
  external: ["@earendil-works/pi-coding-agent"],
  format: "esm",
  logLevel: "info",
  outfile,
  platform: "node",
  target: "node22.19",
  tsconfig: "tsconfig.json"
});

chmodSync(outfile, 0o755);
