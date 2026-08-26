# System prompt customization

The Agent Runtime resolves system-prompt customization from SDK options and discovered static files.

## Inputs and precedence

| Input | Source | Effect |
|---|---|---|
| `CreateAgentSessionOptions.customSystemPrompt` | Host/SDK | Replaces the default instruction template; highest precedence |
| discovered `SYSTEM.md` | Capability discovery | Uses the custom prompt template when no host override is supplied |
| `CreateAgentSessionOptions.appendSystemPrompt` | Host/SDK | Appends host text after generated Runtime additions |
| discovered `APPEND_SYSTEM.md` | Capability discovery | Appends file content when no host override is supplied |
| `TITLE_SYSTEM.md` | Title prompt discovery | Overrides automatic session-title instructions |

Discovery covers the configured OMP, Claude, Codex, Gemini, agent, and extension capability roots according to the normal discovery precedence. The native Runtime user root defaults to `~/.omp/agent` and may be relocated by the supported environment/config APIs.

## Template behavior

A custom system prompt is not emitted as an unstructured sole message. `buildSystemPrompt()` renders `custom-system-prompt.md`, preserving generated project context, skills, rules, secret-redaction guidance, and the project/environment footer.

Append-only customization keeps the default instruction template and adds host/file text at the documented append position. This is the preferred option when a caller only needs extra policy.

The current date and cwd are emitted through the per-request reminder rather than changing the stable system-prompt prefix.

## Plain-text contract

Custom and append inputs are plain text inserted into static Handlebars templates. Their content is not recursively evaluated as Handlebars. Paths passed through the SDK are resolved by `resolvePromptInput()`; multiline strings are always treated as literal content.

## Runtime additions

After resolving host and file customization, the SDK may append enabled memory, security, auto-learn, MCP, computer-use, and extension guidance. These generated blocks remain host-independent and follow the same token/accounting path as the default prompt.

## Title generation

`TITLE_SYSTEM.md` or the corresponding resolved host value is applied only to automatic session-title generation. It does not replace the main Agent Runtime prompt.

## Implementation

- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/system-prompt.ts`
- `packages/coding-agent/src/capability/system-prompt.ts`
- `packages/coding-agent/src/prompts/system/system-prompt.md`
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md`
- `packages/coding-agent/src/prompts/system/project-prompt.md`
