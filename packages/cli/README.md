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

By default, `openstrat init` creates the active runtime home at
`<project>/.openstrat`. Auth, objects, datasets, event logs, transcripts, and
project artifacts for that strategy workspace live there. Set `OPENSTRAT_HOME`
only when you intentionally want to override the project-local home, such as in
hermetic tests.

Machine-readable output:

```bash
openstrat doctor --json
openstrat market snapshot BTC-PERP --json
```

`--json` is a global flag. It suppresses intermediate human stdout/stderr and
emits one JSON line with an `AgentResultEnvelope`:

- `completed` for successful commands
- `blocked` for CLI contract failures such as usage errors or unknown commands
- `failed` for runtime or project-state failures

Guarded live market-data smoke:

```bash
openstrat market ingest-live --symbol HYPE-PERP --interval 15m --lookback-minutes 60 --confirm-live --json
openstrat market snapshot HYPE-PERP --json
```

`ingest-live` is read-only, opt-in, and guarded by `--confirm-live`. It writes
local runtime artifacts under the active project `.openstrat` home; it is not
required for the fixture-backed test suite.

## Agent Runtime

`openstrat chat` defaults to the Codex app-server runtime:

```bash
openstrat chat --prompt "Research BTC funding context."
```

The Codex path stores OpenStrat-owned runtime state under the active project
`.openstrat` home:

- `agent-runtime/codex-app-server-bindings/*.json` maps OpenStrat session ids to
  Codex thread ids and transcript refs.
- `agent-runtime/sessions/*.jsonl` stores OpenStrat-projected transcript events.
- `state.sqlite` stores the append-only event log.

Resume a Codex chat session with the session id printed by the first run:

```bash
openstrat chat --resume agent_session_123 --prompt "Continue from the same thread."
```

Pi remains available as an explicit compatibility/runtime path:

```bash
openstrat chat --runtime pi --prompt "Use the Pi runtime path."
```

Codex-native file and shell tools stay disabled in this harness path. Trading,
research, risk, proposal, and deployment tools must route through OpenStrat's
audited `AgentToolGateway`. OpenRouter/BYOK support is intentionally limited to
model/profile boundaries for now; it is not wired into the Codex app-server
session lifecycle.
