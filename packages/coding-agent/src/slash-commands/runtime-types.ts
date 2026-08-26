import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

export interface SubcommandDef {
	name: string;
	description: string;
	usage?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	aliases?: string[];
	description: string;
	allowArgs?: boolean;
	subcommands?: SubcommandDef[];
	inlineHint?: string;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
	text: string;
}

export type SlashCommandResult = undefined | { consumed: true; agentInvoked?: boolean } | { prompt: string };

export interface SlashCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	output: (text: string) => Promise<void> | void;
	refreshCommands: () => Promise<void> | void;
	reloadPlugins: () => Promise<void>;
	keepTurnOpenUntilIdle?: () => Promise<void>;
	runCommandInBackground?: (task: () => Promise<void>) => void;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

export interface SlashCommandSpec extends BuiltinSlashCommand {
	acpDescription?: string;
	acpInputHint?: string;
	handle?:
		| ((
				command: ParsedSlashCommand,
				runtime: SlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: SlashCommandRuntime) => void | Promise<void>);
}

export type AcpBuiltinSlashCommandResult = false | { consumed: true; agentInvoked?: boolean } | { prompt: string };
