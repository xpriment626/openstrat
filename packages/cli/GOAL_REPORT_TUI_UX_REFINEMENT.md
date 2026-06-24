# TUI UX Refinement Goal Report

## Objective

Refine the OpenStrat workbench TUI toward Pi/Codex visual parity without changing the trading loop. The goal was to keep the Codex SDK runtime and existing OpenStrat trading semantics intact while making the live terminal feel like a real agent workbench instead of a raw section dump.

## Completed Lanes

- Re-grounded in the current dirty worktree, the baseline TUI files, README, built CLI behavior, and provided screenshot/recording evidence.
- Inspected the installed Pi CLI implementation under `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, including message, tool execution, footer, truncation, and session selector components.
- Chose not to add `pi-tui` as a dependency. OpenStrat now borrows the layout pattern locally so the CLI stays Codex-SDK-centered and avoids coupling back to Pi internals.
- Reworked `workbench-tui.ts` around a compact header, grouped command palette, carded transcript entries, focused workbench view cards, diagnostics cards, optional scripted composer, and footer.
- Removed live duplicate composer rendering: scripted/non-TTY output still shows a composer card, while live TTY mode lets readline own the single `openstrat>` prompt.
- Added width-aware rendering down to 48 columns, path middle truncation that preserves `.openstrat`, and `COLUMNS` support for non-TTY scripted output.
- Improved command discovery with grouped `/help` sections and examples.
- Added a targeted generated-bin warning filter for Node's experimental SQLite warning so actual CLI output is not polluted, while leaving other warnings intact.
- Updated README with the new TUI model and removed the outdated "line-oriented TUI" caveat.

## Checkpoint Index

| Lane                | Checkpoint                                               | Commit      | Status    |
| ------------------- | -------------------------------------------------------- | ----------- | --------- |
| Manifest            | `checkpoint/tui-ux-refinement/manifest.md`               | uncommitted | Completed |
| Renderer foundation | `checkpoint/tui-ux-refinement/01-renderer-foundation.md` | uncommitted | Completed |

## Final Gates

- `pnpm vitest run packages/cli/src/commands.test.ts --testNamePattern "TUI|market|sessions|Codex progress"`: passed
- `pnpm vitest run packages/cli/src/commands.test.ts`: passed, 19 tests
- `pnpm test`: passed, 13 files and 73 tests
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `pnpm lint`: passed
- `pnpm format:check`: passed
- `git diff --check`: passed
- Built-binary 100-column smoke in `/tmp/openstrat-tui-final.yRKubA`: passed. Covered bare `openstrat`, `/help`, `/markets SOL`, `/datasets plan`, `/sessions`, one fake Codex turn, `/compact`, `/ready`, and `/exit`.
- Built-binary 54-column smoke in `/tmp/openstrat-tui-narrow.VZ8pss`: passed with no line overflow.
- Live TTY smoke in `/tmp/openstrat-tui-tty.QKYqug`: passed. Confirmed compact first viewport, selected market cards, no duplicate composer, no SQLite warning, and clean `/exit`.

## Remaining Issues

- Vitest still prints Node's SQLite experimental warning because tests import modules directly rather than going through the generated CLI bin. The shipped/built CLI path filters that specific warning before import.
- The TUI is still not a full alternate-screen app with scrollback controls, command palette selection, mouse-like navigation, or interactive session picker. Those remain future polish, not blockers for the local strategy workflow.
- The footer uses compact session/artifact refs. Full session ids and paths are still available through `/status`, `/sessions`, transcripts, and project `.openstrat`.

## Next Goal Recommendation

Recommendation: continue toward real local workflow trials and then wallet/deployment prerequisites, not another mandatory TUI polish pass.

Readiness: ready for a real user to try the full local strategy workflow, excluding wallets and cloud deployment.

Rationale: the terminal now has the baseline production shape needed for evaluation: compact status, grouped commands, rich transcript cards, focused command views, visible Codex/tool progress, clean live prompt behavior, deterministic non-TTY output, and width-safe rendering. More polish would improve comfort, but it is no longer required before testing the local strategy loop.

## Required Final Question

Is the TUI now good enough for a real user to try the full local strategy workflow, excluding wallets and cloud deployment, or is another TUI polish pass needed first?

Answer: yes, it is good enough for a real user trial of the local strategy workflow. Another TUI polish pass can be planned later for alternate-screen navigation and richer interaction controls, but the current TUI no longer blocks end-to-end local strategy generation, dataset, backtest, risk, session, and artifact testing.
