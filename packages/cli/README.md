# OpenStrat CLI

Status: local end-to-end Codex SDK strategy workbench trial, minus wallet and deployment.

## Global Install Trial

For a realistic local package lifecycle trial, install the built package into your
normal global npm prefix and let OpenStrat use its default homes:

```bash
pnpm build
npm install -g "$PWD/packages/cli"
hash -r

mkdir -p "$HOME/openstrat-lifecycle-trial"
cd "$HOME/openstrat-lifecycle-trial"

openstrat doctor
openstrat
```

That creates project state under `./.openstrat` and user-scoped OpenStrat state
under `~/.openstrat`. It must not create, remove, or mutate the standalone Codex
installation. If Codex is already installed, OpenStrat treats it as an external
provider.

Before removing the package, review OpenStrat-owned state:

```bash
openstrat uninstall --dry-run
```

Then either remove the selected OpenStrat-owned state through the planner:

```bash
openstrat uninstall --yes
```

or remove scopes explicitly:

```bash
openstrat cleanup --project --yes
openstrat cleanup --user --yes
```

Finally remove the global package:

```bash
npm uninstall -g @openstrat/cli
```

Verification:

```bash
command -v openstrat || echo "openstrat removed"
test ! -d "$HOME/openstrat-lifecycle-trial/.openstrat" && echo "project state removed"
test ! -d "$HOME/.openstrat" && echo "user state removed"
codex --version
```

The cleanup commands preserve external Codex state and installation paths,
including `~/.codex`, project `.codex/`, Homebrew/App binaries, and Codex
keychain-backed auth.

Use a temp prefix only when you intentionally want a disposable development
harness:

```bash
pnpm build
export OPENSTRAT_PREFIX=/tmp/openstrat-prefix
npm install -g --prefix "$OPENSTRAT_PREFIX" "$PWD/packages/cli"
export PATH="$OPENSTRAT_PREFIX/bin:$PATH"

export CODEX_HOME=/tmp/openstrat-codex-home
export OPENSTRAT_USER_HOME=/tmp/openstrat-user-home
mkdir -p /tmp/openstrat-trial/project
cd /tmp/openstrat-trial/project
export OPENSTRAT_HOME="$PWD/.openstrat"

openstrat doctor
openstrat auth codex
openstrat
```

`openstrat doctor` should show the Node version, CLI entrypoint, executable bit, dist index, Codex auth status, and project/user homes. Cleanup:

```bash
openstrat uninstall --dry-run
openstrat uninstall --yes
npm uninstall -g --prefix "$OPENSTRAT_PREFIX" @openstrat/cli
rm -rf "$OPENSTRAT_PREFIX" /tmp/openstrat-codex-home /tmp/openstrat-user-home /tmp/openstrat-trial
```

## User Flow

From an OpenStrat project directory:

```bash
openstrat
```

Bare `openstrat` opens the workbench TUI. Natural language goes to Codex SDK. OpenStrat slash commands are deterministic product commands around trading state.

The TUI uses an in-repo renderer that borrows the Codex/Pi agent-console shape without depending on Pi runtime internals. It stays deterministic for tests, fake-runtime smokes, and local package lifecycle checks while giving the live workbench a denser agent surface:

- compact header: runtime, Codex auth status, readiness, evidence counts, project/user homes, and next action
- grouped command palette: core, market-data, strategy-loop, session, and intentionally unavailable deploy commands
- transcript cards: user prompts, command outcomes, Codex progress/tool events, and final responses
- workbench view: focused structured output for the latest slash command
- diagnostics cards: routed command/runtime errors and warnings
- footer: cwd, runtime, compact session id, and latest artifact ref
- composer: a single `openstrat>` prompt; scripted output renders the composer as a card, live TTY mode lets readline own the prompt so it is not duplicated

- `/status`
- `/help`
- `/guide`
- `/model`
- `/effort`
- `/markets`
- `/datasets`
- `/strategy`
- `/backtest`
- `/risk`
- `/ready`
- `/artifacts`
- `/sessions`
- `/new`
- `/resume <session-id>`
- `/compact`
- `/deploy`

Codex owns model execution, native file edits, shell commands, sandboxing, approvals, and thread IDs. OpenStrat owns project trading state: dataset indexes, market indexes, object refs, strategy validation artifacts, backtest reports, risk preflight reports, readiness summaries, sessions, transcripts, summaries, and artifact indexes under project `.openstrat`.

The first TUI screen is intentionally compact: it shows the local strategy readiness state, market/data/strategy/backtest/artifact counts, config boundaries, grouped commands, transcript state, and the next suggested action without spending the first viewport on full absolute paths.

## Auth And Homes

Use isolated homes for repeatable development:

```bash
export CODEX_HOME=/tmp/openstrat-codex-home
export OPENSTRAT_USER_HOME=/tmp/openstrat-user-home
export OPENSTRAT_HOME="$PWD/.openstrat"
openstrat auth codex
openstrat doctor
```

`openstrat auth codex` delegates to Codex login using the configured `CODEX_HOME`. OpenStrat treats Codex auth as opaque. It checks whether auth exists, but does not read or print token contents.

Project `.openstrat` is for OpenStrat state only. User-scoped OpenStrat preferences belong under `OPENSTRAT_USER_HOME`. Codex credentials belong under `CODEX_HOME` or the OS credential store.

## Interactive Trading Loop

The intended local loop is:

1. Ask Codex for a data plan in natural language.
2. Review the proposed ingest command.
3. Run the deterministic ingest command only after approval.
4. Validate dataset refs.
5. Inspect dataset coverage, refs, candle counts, and validation status.
6. Have Codex use the OpenStrat strategy guide to write or revise `@openstrat/strategy-sdk` code.
7. Validate the strategy manifest, source constraints, required data, and deterministic output probe.
8. Plan and run a local candle backtest with explicit run/equity/fee/slippage config.
9. Run local risk/evidence preflight with optional policy thresholds.
10. Inspect `/artifacts` for dataset refs, strategy guidance, validation, backtest metrics, and risk preflight output.
11. Run `/ready` to confirm the local evidence package is complete while wallet and deployment remain unconfigured.

Example prompt:

```text
I need a dataset for SOL token that we can use to build a scalping strategy in the 5 or 15m timeframes.
```

Equivalent deterministic command:

```bash
openstrat datasets plan --prompt "I need a dataset for SOL token that we can use to build a scalping strategy in the 5 or 15m timeframes."
```

The plan returns paste-ready commands such as:

```bash
openstrat datasets ingest --symbol SOL --interval 5m --start <iso-start> --end <iso-end> --live
```

Inside the TUI, `/markets` refreshes the Hyperliquid perps catalog before any dataset exists. Use a symbol argument to filter/select a market and get the next dataset command:

```text
/markets SOL
```

The focused market view should show `selected: SOL-PERP` and a next action like:

```text
/datasets plan --symbol SOL SOL token 5m and 15m scalping data
```

For offline smoke tests, use fixture data:

```bash
openstrat datasets ingest --symbol SOL --interval 5m --start 2026-06-01T00:00:00.000Z --end 2026-06-01T01:00:00.000Z --fixture
openstrat datasets validate
openstrat datasets inspect
openstrat strategy guide --strategy src/strategy.ts
openstrat strategy validate --strategy src/strategy.ts
openstrat backtest plan --strategy src/strategy.ts --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id sol_scalper_smoke
openstrat backtest run --strategy src/strategy.ts --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id sol_scalper_smoke
openstrat risk preflight --strategy src/strategy.ts --backtest sol_scalper_smoke --max-notional 1500 --max-drawdown-pct 25 --min-trades 1 --min-win-rate 0 --policy-ref risk/local-test
openstrat artifacts latest
openstrat ready
```

## Slash Commands

Useful slash command equivalents:

```text
/help
/guide
/model
/effort
/datasets plan SOL token 5m and 15m scalping data
/datasets ingest --symbol SOL --interval 5m --start 2026-06-01T00:00:00.000Z --end 2026-06-01T01:00:00.000Z --fixture
/datasets validate
/datasets inspect
/strategy guide --strategy src/strategy.ts
/strategy validate --strategy src/strategy.ts
/backtest plan --strategy src/strategy.ts --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id sol_scalper_smoke
/backtest run --strategy src/strategy.ts --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id sol_scalper_smoke
/risk preflight --strategy src/strategy.ts --backtest sol_scalper_smoke --max-notional 1500 --max-drawdown-pct 25 --min-trades 1 --min-win-rate 0 --policy-ref risk/local-test
/artifacts latest
/ready
```

Ingestion requires either `--fixture` for deterministic local data or `--live` for Hyperliquid read-only API access. OpenStrat does not silently fake live ingestion.

## Codex Tool Bridge

The CLI configures a local OpenStrat MCP stdio bridge for Codex SDK turns. The bridge exposes canonical OpenStrat tool names with MCP-safe underscores:

- `market_data_read_snapshot`
- `dataset_plan_ingestion`
- `dataset_execute_ingestion`
- `dataset_validate`
- `dataset_inspect`
- `strategy_guide`
- `strategy_validate`
- `backtest_plan`
- `backtest_run`
- `backtest_request`
- `risk_preflight`
- `risk_validate_intent`
- `strategy_patch_capture`
- `memory_proposal_capture`
- `deployment_gate_inspect`

Codex native file/shell tools stay available under Codex sandbox and approval policy. OpenStrat tools provide trading-environment context and artifacts.

## Artifact Layout

Project `.openstrat` stores:

- `objects/`: raw and normalized market data, backtest reports, risk preflight reports, validation records.
- `datasets/index.json`: project dataset index.
- `datasets/markets.json`: project market index.
- `objects/datasets/inspection/`: persisted dataset inspection artifacts.
- `objects/strategies/guides/`: strategy authoring guides and templates.
- `backtests/index.json`: local backtest report index.
- `risk/preflight-index.json`: local risk preflight index.
- `artifacts/index.json`: session-visible artifact projection.
- `sessions/`, `transcripts/`, `summaries/`: workbench session state.

## Current Gaps

- The TUI now has carded messages, focused command views, grouped help, width-aware wrapping, and a footer. Full alternate-screen keyboard navigation, scrollback controls, and mouse-like command selection remain deferred.
- Live Hyperliquid ingestion depends on external API availability and explicit `--live`.
- Strategy validation now checks manifests, imports, required data, and deterministic output against dataset candles, but broader strategy packaging and dependency management are still minimal.
- Backtest and risk preflight are local evidence gates, not strategy-quality assessment or live-trading approval.
- Wallet signing, live trading, cloud deployment, deployed monitoring, and real-time PnL/trade analytics are intentionally out of scope for this slice.
