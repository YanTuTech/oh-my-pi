import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "./builtin-reserved-names";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import type { SlashCommandSpec } from "./runtime-types";

export type { BuiltinSlashCommand, SubcommandDef } from "./runtime-types";

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

for (const name of BUILTIN_SLASH_COMMAND_LOOKUP.keys()) {
	if (!BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name)) {
		throw new Error(`Built-in slash command '${name}' is missing from the headless reserved-name registry`);
	}
}
for (const name of BUILTIN_SLASH_COMMAND_RESERVED_NAMES) {
	if (!BUILTIN_SLASH_COMMAND_LOOKUP.has(name)) {
		throw new Error(`Headless reserved slash-command name '${name}' has no built-in command`);
	}
}

export { BUILTIN_SLASH_COMMAND_RESERVED_NAMES };

/** Unified registry exposed to ACP/RPC hosts. */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "./runtime-types";
