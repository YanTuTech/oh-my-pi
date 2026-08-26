# Custom Tools Examples

Example custom tools for omp-coding-agent.

## Examples

Each example uses the `subdirectory/index.ts` structure required for tool discovery.

### hello/

Minimal example showing the basic structure of a custom tool.

### todo/

Full-featured example demonstrating:

- `onSession` for state reconstruction from session history
- Proper branching support via details storage
- State management without external files

## Writing Custom Tools

See [docs/custom-tools.md](../../docs/custom-tools.md) for full documentation.

### Key Points

**Factory pattern:**

```typescript
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
	name: "my_tool",
	label: "My Tool",
	description: "Tool description for LLM",
	parameters: pi.zod.object({
		action: pi.zod.enum(["list", "add"]),
	}),

	// Called on session start/switch/branch/clear
	onSession(event) {
		// Reconstruct state from event.entries
	},

	async execute(toolCallId, params) {
		return {
			content: [{ type: "text", text: "Result" }],
			details: { /* for state reconstruction */ },
		};
	},
});

export default factory;
```
**Use `z.enum` for discriminated string tool args:**

```typescript
const z = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```
