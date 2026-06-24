# Baseline TUI Goal Report

## Summary

OpenStrat now has a first-pass structured TUI render layer for the Codex-backed trading workbench. The CLI still supports deterministic scripted/fake-runtime tests, but bare `openstrat` now projects state through a workbench screen instead of only printing raw command blocks.

## What Changed

- Added `workbench-tui.ts`, an in-repo state/render layer for the baseline TUI.
- Wired the bare `openstrat` loop through structured screens with header state, command palette, transcript, focused workbench view, diagnostics, and composer.
- Projected slash command results into focused views for markets, datasets, strategy, backtest, risk, artifacts, sessions, readiness, status, help, and guide commands.
- Routed unknown slash commands and runtime failures into the diagnostics panel while keeping the TUI loop alive.
- Kept natural-language Codex turns first-class by projecting user prompts, `codex: working`, Codex progress events, and final responses into the transcript.
- Improved `/markets` so `/markets SOL` filters/selects `SOL-PERP` and proposes `/datasets plan --symbol SOL ...` as the next action.
- Preserved the project/user home boundary and fake-runtime scripted path used by automated tests.

## TUI Stack Decision

This pass intentionally uses an in-repo renderer instead of Ink, Blessed, or another terminal UI framework. The baseline need was to make the workbench state model explicit and testable without adding a heavier dependency or making CI depend on terminal emulation. A later polish pass can move the same state model into an alternate-screen renderer with richer keyboard navigation.

## Verification So Far

- `pnpm vitest run packages/cli/src/commands.test.ts --testNamePattern "structured workbench TUI|selected Hyperliquid market"`
- `pnpm vitest run packages/cli/src/commands.test.ts --testNamePattern "projects command views"`
- `pnpm vitest run packages/cli/src/commands.test.ts --testNamePattern "fake Codex write strategy"`
- `pnpm vitest run packages/cli/src/commands.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm lint`
- `pnpm format:check`
- `git diff --check`
- `pnpm --filter @openstrat/cli typecheck`
- `pnpm --filter @openstrat/cli build`
- Global installed-artifact smoke from `~/openstrat-lifecycle-trial` using default homes and `OPENSTRAT_CODEX_RUNTIME=fake`: doctor, `/markets SOL`, dataset plan/fixture ingest/validate/inspect, fake Codex strategy write, strategy guide/validate, backtest, risk preflight, artifacts, sessions, compact, `/ready`.
- Session smoke from the same installed artifact: `/sessions`, `/resume <session-id>`, `/new`, `/compact`.
- Narrow scripted smoke with `COLUMNS=72`: `/markets SOL`, `/ready`.

## Wallet Readiness Answer

The TUI baseline is now good enough for a user to try the local end-to-end strategy workbench without wallet or deployment. It reaches a complete local evidence package: market selection, dataset evidence, strategy code, strategy validation, backtest, risk preflight, artifacts, session summary, and `/ready`.

Wallet provisioning can be the next product goal if the remaining full-repo verification gate passes. The main caveat is polish, not a blocker: the current TUI uses a structured renderer with TTY redraw and deterministic script output. A later pass should improve command palette navigation, richer keyboard controls, and transcript compaction/scrolling, but those are not prerequisites for testing wallet provisioning behavior.
