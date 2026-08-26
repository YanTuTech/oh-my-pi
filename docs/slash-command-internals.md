# Runtime command registry

The slash-command registry is retained as a headless command protocol for RPC, ACP, extensions, and host applications. There is no bundled command-line parser or terminal composer.

## Sources

- `src/slash-commands/builtin-registry.ts`
- `src/slash-commands/runtime-types.ts`
- `src/slash-commands/builtin-*.ts`
- `src/extensibility/custom-commands/`
- `src/extensibility/extensions/get-commands-handler.ts`
- `src/modes/rpc/rpc-mode.ts`
- `src/modes/acp/acp-agent.ts`

## Registry contract

Commands have stable names, descriptions, argument metadata, and async handlers. Built-ins and extension-provided commands are merged through deterministic precedence and are projected to protocol hosts as metadata.

A host may render autocomplete or another command affordance, but that rendering is outside the Runtime. The Runtime only parses the selected command payload, invokes the handler, and returns output/events.

## Host interaction

Handlers may call the retained host interaction contract for select, confirm, input, editor, notification, status, and widget requests. RPC and ACP serialize those requests; SDK embeddings supply their own implementation. With no host implementation, UI-dependent operations fail explicitly or return an unavailable result.

## Session safety

Command handlers use the same AgentSession lifecycle guards as direct SDK calls. They must not bypass streaming, compaction, persistence, authorization, or cancellation rules merely because they were invoked through a textual command.

## Extensions

Extension commands remain supported for backward compatibility. Hotkeys, component factories, terminal rendering, and theme switching have no built-in implementation in the headless Runtime, though compatibility types remain so existing extensions can be loaded and a host can project supported interactions.
