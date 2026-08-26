# Oh My Pi Agent Runtime

A headless, embeddable coding-agent Runtime for Research Buddy and other host applications. The Runtime owns model/provider streaming, tool execution, sessions, memory, MCP, extensions, subagents, RPC/ACP transports, and standalone HTML export.

This branch intentionally contains no end-user CLI, terminal UI, browser collaboration client, dashboard, or interactive component system.

## Runtime surfaces

| Entry | Purpose |
|---|---|
| `@oh-my-pi/pi-coding-agent` | Complete headless SDK and host API |
| `@oh-my-pi/pi-coding-agent/runtime` | Embeddable Runtime-only API |
| `@oh-my-pi/pi-coding-agent/runtime-rpc-host` | JSONL RPC process host |
| `@oh-my-pi/pi-coding-agent/runtime-acp-host` | ACP process host |
| `@oh-my-pi/pi-coding-agent/export/html` | Standalone session HTML export |
| `@oh-my-pi/pi-agent-core` | Provider-neutral agent state machine |
| `@oh-my-pi/pi-ai` | Multi-provider LLM client and streaming |
| `@oh-my-pi/pi-mnemopi` | Local SQLite memory engine |
| `@oh-my-pi/omp-stats` | Headless session usage analytics |

`RpcClient` launches the dedicated Runtime RPC host by default. Host applications can instead import `createAgentSession` directly or run the ACP host.

## Embedding

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/runtime";

const { session } = await createAgentSession({
  cwd: "/workspace/project",
  hasUI: false,
});

session.subscribe(event => {
  // Project Runtime events into the host application's own UI.
});

await session.prompt("Inspect the project and summarize its architecture.");
```

For process isolation, use the RPC client:

```ts
import { RpcClient } from "@oh-my-pi/pi-coding-agent";

const client = new RpcClient();
await client.start();
await client.prompt("Review the current workspace.");
```

The RPC and ACP protocols retain interaction contracts such as select, confirm, input, editor, notify, status, and widget. These are host-facing protocol capabilities, not bundled UI implementations.

## Standalone HTML export

```ts
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";

const outputPath = await exportFromFile("/path/to/session.jsonl");
```

HTML exports embed their scripts, styles, and rich tool-card web component. The export supports fixed light, dark, and automatic web themes without depending on the removed terminal palette system.

## Runtime capabilities

- Multi-provider streaming, thinking, retry, and usage accounting
- Built-in read, edit, shell, search, browser, notebook, image, LSP, and MCP tools
- Session persistence, migration, ranking, compaction, branching, and export
- SQLite, Redis, and indexed session storage adapters
- Local and remote memory backends
- Extensions, hooks, skills, plugins, custom tools, and custom commands
- Subagents, tasks, goals, collaboration wire protocol, and host interaction events
- JSONL RPC and ACP process hosting
- Worker-isolated evaluation, embeddings, and supporting subprocesses
- Headless analytics for session usage and model cost

## Repository packages

| Package | Description |
|---|---|
| [`@oh-my-pi/pi-coding-agent`](packages/coding-agent) | Headless Agent Runtime, SDK, RPC/ACP hosts, and HTML export |
| [`@oh-my-pi/pi-agent-core`](packages/agent) | Agent loop, tool calling, and state management |
| [`@oh-my-pi/pi-ai`](packages/ai) | Provider clients and streaming protocols |
| [`@oh-my-pi/pi-catalog`](packages/catalog) | Model catalog, provider descriptors, and identity |
| [`@oh-my-pi/pi-natives`](packages/natives) | Native text, grep, image, clipboard, and syntax operations |
| [`@oh-my-pi/pi-mnemopi`](packages/mnemopi) | Local SQLite memory engine |
| [`@oh-my-pi/omp-stats`](packages/stats) | Headless usage aggregation and analytics |
| [`@oh-my-pi/pi-wire`](packages/wire) | Collaboration and host wire contracts |
| [`@oh-my-pi/omptype`](packages/omptype) | Runtime schema validation |
| [`@oh-my-pi/pi-utils`](packages/utils) | Shared logging, streams, environment, and process utilities |
| [`@oh-my-pi/hashline`](packages/hashline) | Line-anchored edit language and applier |
| [`@oh-my-pi/snapcompact`](packages/snapcompact) | Session compaction support |

Developer-only benchmark and integration packages are not part of the shipped Runtime surface.

## Development

```sh
bun install
bun run check
bun run ci:test:coding-agent:runtime
bun run ci:test:smoke
bun run ci:test:install-methods
```

`bun run ci:test:install-methods` packs the workspace packages, installs them into a clean temporary project, verifies the Runtime/RPC/ACP/HTML public surface, verifies the native leaf package, and asserts that no legacy `omp` executable is installed.

The internal `packages/coding-agent/src/cli.ts` file is only a hidden worker re-entry dispatcher required by bundled host processes. It is blocked from package exports and is not an end-user CLI.

See [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) for the source map and verification boundary.

## License

MIT
