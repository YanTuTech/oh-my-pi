# Runtime extensions

An extension is a TypeScript or JavaScript module whose default factory receives `ExtensionAPI`. Extensions run inside the Agent Runtime and may register tools, commands, hooks, providers, skills, and lifecycle handlers.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function extension(api: ExtensionAPI) {
  api.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded", "info");
  });
}
```

The `ui` name is retained for API compatibility. In this headless Runtime it means the host interaction contract, not a bundled terminal UI.

## Supported capabilities

- subscribe to session, agent, tool, compaction, branch, and lifecycle events;
- register model-callable tools and headless command handlers;
- inspect or modify enabled tools;
- add skills, prompt fragments, MCP servers, and capability contributions;
- request host interaction through notify, select, confirm, input, editor, status, title, and widget methods;
- invoke session operations exposed by the extension context;
- load compatible legacy Pi extensions through the retained shim.

## Host interaction contract

RPC and ACP serialize interaction requests to the embedding host. A direct SDK host supplies its own implementation. When no implementation exists, interaction-dependent operations return an unavailable/failure result.

Component factories, render callbacks, theme shapes, and key identifiers remain in the TypeScript compatibility surface so existing extensions can load and so a host may adapt them. The Runtime does not include a renderer, keyboard dispatcher, terminal theme registry, overlay, or component toolkit.

Extensions must not write protocol traffic to stdout. Use the shared logger for diagnostics.

## Tools

`api.registerTool(...)` registers an `AgentTool` with a static schema, execution function, and optional metadata. Tool results use the standard `AgentToolResult` content/details shape and are projected unchanged through SDK, RPC, ACP, transcripts, and HTML export.

Legacy render callbacks may be accepted as compatibility metadata, but no built-in Runtime surface invokes a terminal renderer.

## Commands

`api.registerCommand(...)` adds a command to the headless command registry. RPC/ACP hosts can list and execute those commands. Applications decide whether to render a command palette, textual input, menu, or no command UI at all.

## Hooks and events

Hook handlers receive stable lifecycle data and an abort signal where applicable. Before-events may cancel or transform operations according to their documented contract. Extensions should keep handlers bounded and release resources on session shutdown.

## Discovery

Extension discovery, precedence, disabled entries, npm/link plugins, and project/user roots are documented in [extension-loading.md](./extension-loading.md). Explicit host paths are passed through `CreateAgentSessionOptions.additionalExtensionPaths`.

## Compatibility boundary

The following are retained because removing them would break Runtime extension loading:

- `ExtensionUIContext` interaction methods;
- legacy Pi coding-agent shims;
- theme/component/key types referenced by extension signatures;
- command and hook context types;
- renderer metadata stored on third-party tools.

The following implementations are intentionally absent:

- `@oh-my-pi/pi-tui`;
- interactive mode and controllers;
- built-in components, selectors, overlays, composer, keybindings, and themes;
- CLI extension flags and command adapters.

## Implementation

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/ui-contract.ts`
- `src/extensibility/plugins/`
- `src/modes/rpc/rpc-mode.ts`
- `src/modes/acp/acp-agent.ts`
