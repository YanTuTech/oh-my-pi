# Agent Runtime boundary

This document defines the repository boundary for the headless Agent Runtime. The machine-readable source of truth is [`runtime-boundary.json`](../runtime-boundary.json); `bun run check:runtime-boundary` enforces it.

The boundary is about executable product scope. It does not classify code by whether a filename, protocol field, compatibility type, comment, or historical changelog happens to contain words such as “UI”, “CLI”, or “TUI”.

## Must remain

The Runtime must continue to provide:

- the agent state machine, model/provider streaming, sessions, task execution, tools, permissions, compaction, memory, and observability;
- SDK embedding through the package root and `./runtime`;
- headless RPC and ACP hosts without changing their protocols;
- extension, plugin, hook, Skill, MCP, and custom-tool loading;
- standalone HTML session export;
- native helpers and browser/computer tool transports.

The required source paths, build entrypoints, and package exports are listed in `runtime-boundary.json`. Their presence alone does not prove behavior, so the Runtime test suites remain mandatory.

## Must not remain

The Runtime package must not ship:

- an end-user executable or public CLI entrypoint;
- the terminal UI package or terminal rendering dependencies;
- interactive-mode, print-mode, composer, component, controller, setup-wizard, theme, splash, or dashboard implementations;
- imports of terminal or React UI libraries in the Runtime build dependency graph.

The exact forbidden paths, package exports, dependencies, public symbols, and build inputs are listed in `runtime-boundary.json`. A new terminal product path is not allowed merely because it uses a different name; the manifest must be updated when a new structural category is identified.

UI-only native bindings and persisted settings are also retired contractually. The checker rejects their generated N-API declarations and settings-schema registrations, so an implementation cannot silently return under a new source layout while keeping the old public surface.

## Explicitly retained exceptions

Some retained code has UI-adjacent names but belongs to a Runtime contract:

| Path | Boundary reason |
|---|---|
| `packages/coding-agent/src/cli.ts` | Private worker re-entry dispatcher. Hidden worker selectors re-enter one host module; `./cli` remains blocked publicly. |
| `packages/coding-agent/src/extensibility/ui-contract.ts` | Structural RPC/ACP and third-party extension types plus a plain-text Runtime theme. It contains no terminal renderer. |
| extension shortcut, composer, flag, and theme signatures | Third-party compatibility. The Runtime accepts these declarations without providing a local UI consumer. |
| `packages/coding-agent/src/slash-commands` | Host command routing and reserved-name compatibility, including non-interactive RPC/SDK use. |
| `packages/coding-agent/src/export/html` | User-approved standalone HTML export capability. |
| `packages/collab-web` | Private build-time React source used only to generate static HTML tool views. It is not a shipped client or Runtime dependency. |
| `packages/browser-relay` | Browser-tool transport for controlling existing tabs, not an Agent application UI. |
| `packages/stats` | Headless analytics and aggregation with no executable or dashboard. |
| `packages/utils/src/cli.ts` | Published argument-parsing compatibility API. It installs no executable and contains no terminal renderer. |
| `packages/coding-agent/src/compress` | Published headless compression workflow. Its command-shaped API is functionality, not UI. |
| `packages/coding-agent/src/commit` | Published commit workflow plus Git/message helpers that Runtime code still imports. |
| `packages/coding-agent/src/modes/acp/terminal-auth.ts` | Observable ACP authentication capability; deleting it would change the protocol. |
| `packages/coding-agent/src/config/model-resolver.ts` | Core model resolution and published compatibility functions used through the config subpath. |

Every exception must exist in the versioned manifest and include a concrete reason. Removing an exception requires a compatibility decision and relevant regression coverage; it must not be inferred from its name.

## Enforced checks

`bun run check:runtime-boundary` fails when:

1. a required Runtime path, entrypoint, or package export disappears;
2. a forbidden terminal path returns;
3. the Runtime package exposes a terminal entrypoint or declares a UI dependency;
4. an actual Bun build of every Runtime entrypoint pulls a forbidden UI input into its dependency graph;
5. retired UI settings or native UI symbols return to their generated public contracts;
6. removed CLI-only model-resolution helpers return to the model-resolver surface;
7. an exception is missing, duplicated, or lacks a concrete reason.

`runtime-package-surface.test.ts` separately verifies the observable SDK/RPC/ACP/HTML package surface and forbidden public symbols. The full Runtime suite verifies behavior and protocols.

The boundary is accepted only when the manifest checker, package-surface test, type checks, and Runtime tests pass from the same revision. “No grep hits” or a manual review is supporting evidence, not a completion criterion.

## Change policy

Any boundary change must update the manifest, this document, and relevant contract tests together. Historical changelogs are not executable product code and remain immutable. A final cleanup claim must name the revision and report the gate results; it must not be based only on visual inspection.
