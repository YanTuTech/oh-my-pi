import type { CreateAgentSessionOptions } from "./sdk";
import { parseConfiguredThinkingLevel } from "./thinking";

export interface RuntimeRpcArgs {
	provider?: string;
	model?: string;
	sessionDir?: string;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	customSystemPrompt?: string;
	appendSystemPrompt?: string;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	toolNames?: string[];
	extensionPaths: string[];
	noSession: boolean;
	continueSession: boolean;
	disableExtensionDiscovery: boolean;
	disableSkills: boolean;
	disableRules: boolean;
	disableLsp: boolean;
	disableTitle: boolean;
	autoApprove: boolean;
	managedRuntime: boolean;
}

export function parseRuntimeRpcArgs(argv: readonly string[]): RuntimeRpcArgs {
	const result: RuntimeRpcArgs = {
		extensionPaths: [],
		noSession: false,
		continueSession: false,
		disableExtensionDiscovery: false,
		disableSkills: false,
		disableRules: false,
		disableLsp: false,
		disableTitle: false,
		autoApprove: false,
		managedRuntime: false,
	};
	const takeValue = (flag: string, index: number): string => {
		const value = argv[index + 1];
		if (!value) throw new Error(`${flag} requires a value`);
		return value;
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--mode") {
			if (takeValue(arg, index) !== "rpc") throw new Error("Runtime RPC host only supports --mode rpc");
			index++;
			continue;
		}
		if (arg === "--provider") {
			result.provider = takeValue(arg, index++);
			continue;
		}
		if (arg === "--model") {
			result.model = takeValue(arg, index++);
			continue;
		}
		if (arg === "--session-dir") {
			result.sessionDir = takeValue(arg, index++);
			continue;
		}
		if (arg === "--provider-session-id") {
			result.providerSessionId = takeValue(arg, index++);
			continue;
		}
		if (arg === "--provider-prompt-cache-key") {
			result.providerPromptCacheKey = takeValue(arg, index++);
			continue;
		}
		if (arg === "--system-prompt") {
			result.customSystemPrompt = takeValue(arg, index++);
			continue;
		}
		if (arg === "--append-system-prompt") {
			result.appendSystemPrompt = takeValue(arg, index++);
			continue;
		}
		if (arg === "--thinking") {
			const value = takeValue(arg, index++);
			const thinkingLevel = parseConfiguredThinkingLevel(value);
			if (!thinkingLevel) throw new Error(`Invalid Runtime thinking level: ${value}`);
			result.thinkingLevel = thinkingLevel;
			continue;
		}
		if (arg === "--tools") {
			result.toolNames = takeValue(arg, index++)
				.split(",")
				.map(name => name.trim())
				.filter(Boolean);
			continue;
		}
		if (arg === "--extension") {
			result.extensionPaths.push(takeValue(arg, index++));
			continue;
		}
		if (arg === "--no-session") {
			result.noSession = true;
			continue;
		}
		if (arg === "--continue") {
			result.continueSession = true;
			continue;
		}
		if (arg === "--no-tools") {
			result.toolNames = [];
			continue;
		}
		if (arg === "--no-extensions") {
			result.disableExtensionDiscovery = true;
			continue;
		}
		if (arg === "--no-skills") {
			result.disableSkills = true;
			continue;
		}
		if (arg === "--no-rules") {
			result.disableRules = true;
			continue;
		}
		if (arg === "--no-lsp") {
			result.disableLsp = true;
			continue;
		}
		if (arg === "--no-title") {
			result.disableTitle = true;
			continue;
		}
		if (arg === "--auto-approve") {
			result.autoApprove = true;
			continue;
		}
		if (arg === "--managed") {
			result.managedRuntime = true;
			continue;
		}
		if (arg === "--no-color") continue;
		throw new Error(`Unknown Runtime RPC option: ${arg}`);
	}
	if (result.provider && !result.model) throw new Error("--provider requires --model");
	if (result.noSession && result.continueSession) throw new Error("--continue cannot be combined with --no-session");
	if (result.disableExtensionDiscovery && result.extensionPaths.length > 0) {
		throw new Error("--no-extensions cannot be combined with --extension");
	}
	if (result.managedRuntime && result.toolNames !== undefined) {
		throw new Error("--managed cannot be combined with --tools or --no-tools");
	}
	if (result.managedRuntime && result.extensionPaths.length > 0) {
		throw new Error("--managed cannot be combined with --extension");
	}
	if (result.managedRuntime && result.autoApprove) {
		throw new Error("--managed cannot be combined with --auto-approve");
	}
	return result;
}
