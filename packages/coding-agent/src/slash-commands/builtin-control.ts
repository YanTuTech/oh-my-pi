import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./runtime-types";

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
	},
	{
		name: "live",
		description: "Start Codex-backed realtime voice mode",
	},
	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
	},
	{
		name: "quit",
		aliases: ["q"],
		description: "Quit the application",
	},
];
