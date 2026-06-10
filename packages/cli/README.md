# OpenStrat CLI

Local link loop:

```bash
pnpm build
cd packages/cli
npm link
hash -r
openstrat --version
```

The linked `openstrat` command uses a generated shell wrapper that prefers the
Node executable beside the npm bin shim. This keeps linked installs on the
active npm prefix even when another `node` appears earlier on `PATH`.

First local smoke loop:

```bash
pnpm build
pnpm --filter openstrat pack --dry-run
npm pack ./packages/cli
npm i -g ./openstrat-*.tgz
mkdir -p /tmp/openstrat-smoke && cd /tmp/openstrat-smoke
openstrat init
openstrat doctor
openstrat auth codex
openstrat chat --prompt "Say hello from OpenStrat in one sentence."
openstrat artifacts
openstrat reset --purge
openstrat doctor
```
