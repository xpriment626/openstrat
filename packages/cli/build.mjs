import { build } from "esbuild";
import { chmodSync, writeFileSync } from "node:fs";

const outfile = "dist/index.js";
const binWrapper = "dist/openstrat";

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
writeFileSync(
  binWrapper,
  `#!/bin/sh
set -eu

case "$0" in
  */*) invoked=$0 ;;
  *) invoked=$(command -v "$0" 2>/dev/null || printf '%s' "$0") ;;
esac

invoked_dir=$(CDPATH= cd -- "$(dirname -- "$invoked")" && pwd -P)
target=$invoked

if [ -L "$target" ]; then
  link=$(readlink "$target")
  case "$link" in
    /*) target=$link ;;
    *) target=$invoked_dir/$link ;;
  esac
fi

target_dir=$(CDPATH= cd -- "$(dirname -- "$target")" && pwd -P)
entry=$target_dir/index.js

if [ -x "$invoked_dir/node" ]; then
  exec "$invoked_dir/node" "$entry" "$@"
fi

exec node "$entry" "$@"
`
);
chmodSync(binWrapper, 0o755);
