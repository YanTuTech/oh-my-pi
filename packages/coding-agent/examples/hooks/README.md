# Hooks Examples

Example hooks for omp-coding-agent.

## Usage

```bash
# Pass the hook module as an additional extension path in your Runtime host.
# runtime-rpc-host also accepts: --extension examples/hooks/permission-gate.ts
```

## Examples

| Hook                     | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.)   |
| `git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch      |
| `protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                  |
| `file-trigger.ts`        | Watches a trigger file and injects contents into conversation                  |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)            |
| `dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                          |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message           |
| `custom-compaction.ts`   | Custom compaction that summarizes entire conversation                          |
| `qna.ts`                 | Sends extracted questions through the host interaction contract                |
| `handoff.ts`             | Transfer context to a new focused Runtime session                              |

## Writing Hooks

See [docs/hooks.md](../../docs/hooks.md) for full documentation.

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

export default function (pi: HookAPI) {
	// Subscribe to events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```
