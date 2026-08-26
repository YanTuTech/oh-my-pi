# Developing `@oh-my-pi/pi-coding-agent`

This package is the headless Agent Runtime used by SDK, RPC, ACP, and worker-process embeddings. It does not publish a CLI or terminal UI.

## Local development

Run from `packages/coding-agent/` (or add `--cwd=packages/coding-agent`):

| Task | Command |
|---|---|
| Typecheck + lint | `bun run check` |
| Types only | `bun run check:types` |
| Lint only | `bun run lint` |
| Runtime tests | `bun run test` |
| Build Runtime assets | `bun run build` |
| Regenerate HTML tool views | `bun run gen:tool-views` from the repository root |

Never invoke `tsc` or `npx tsc` directly; `bun run check` is the typecheck gate.

## Public entrypoints

- `@oh-my-pi/pi-coding-agent` is the complete headless SDK and host surface.
- `@oh-my-pi/pi-coding-agent/runtime` is the embeddable Runtime-only surface.
- `@oh-my-pi/pi-coding-agent/runtime-rpc-host` is the JSONL RPC process host used by `RpcClient`.
- `@oh-my-pi/pi-coding-agent/runtime-acp-host` is the ACP process host.
- `@oh-my-pi/pi-coding-agent/export/html` exports standalone HTML generation.
- Session, tool, extension, MCP, storage, and task modules remain available through explicit package subpaths.

CLI, command-registry, interactive-mode, component, controller, theme, and TUI subpaths are explicitly blocked in `package.json`.

## Runtime flow

```text
SDK caller / RpcClient / ACP client
              │
              ▼
createAgentSession(...)       src/sdk.ts
              │
              ▼
AgentSession                  src/session/agent-session.ts
       │          │
       │          ├── built-in tools, MCP, skills, extensions
       │          ├── session storage, compaction, memory
       │          └── provider streaming and tool execution
       │
       ├── runtime-rpc-host.ts ── JSONL request/event protocol
       └── runtime-acp-host.ts ── ACP protocol
```

`src/cli.ts` remains an internal worker re-entry dispatcher only. Runtime subprocesses re-enter it through hidden `__omp_worker_*` selectors when bundled by a host; it is not exported as a user CLI.

## Source layout

| Directory | Responsibility |
|---|---|
| `sdk.ts`, `runtime-api.ts`, `index.ts` | Public Runtime construction and exports |
| `session/` | AgentSession, persistence, history, migrations, and storage |
| `tools/` | Built-in headless tool implementations and wire metadata |
| `modes/rpc/`, `modes/acp/` | Host protocols and transport adapters |
| `extensibility/` | Extensions, hooks, skills, plugins, and custom tools |
| `mcp/` | MCP manager, transports, authorization, and tool bridge |
| `config/`, `registry/`, `secrets/` | Runtime settings, models, providers, and credentials |
| `task/`, `swarm/`, `irc/`, `goals/` | Delegation and multi-agent coordination |
| `memory-backend/`, `mnemopi/`, `hindsight/` | Memory backends |
| `export/html/` | Standalone HTML export protocol and fixed web theme |
| `subprocess/`, `eval/`, `tiny/` | Isolated worker-backed runtime capabilities |

## Verification

For a focused change, run the nearest package test and `bun run check`. Before release, the workspace additionally validates:

- the Runtime public package surface;
- RPC and ACP hosts;
- standalone HTML export and generated tool views;
- native addon leaf resolution;
- a clean tarball install with no legacy `omp` executable.

Protocol interaction methods such as select, confirm, input, editor, notify, status, and widget are host contracts for RPC/ACP/extensions. They are not terminal UI implementations and must remain backward compatible.
