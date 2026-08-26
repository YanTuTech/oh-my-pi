/** Headless process entrypoint for {@link RpcClient}. */

import { ModelRegistry } from "./config/model-registry";
import { resolveCliModel } from "./config/model-resolver";
import { Settings } from "./config/settings";
import { applyRpcDefaultSettingOverrides } from "./modes/protocol-settings";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { forwardAllRpcSessionEvents, runRpcMode } from "./modes/rpc/rpc-mode";
import type { CreateAgentSessionOptions } from "./sdk";
import { createAgentSession, discoverAuthStorage } from "./sdk";
import { SessionManager } from "./session/session-manager";
import { parseConfiguredThinkingLevel } from "./thinking";
import { EventBus } from "./utils/event-bus";

interface RuntimeRpcArgs {
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
}

function parseRuntimeRpcArgs(argv: readonly string[]): RuntimeRpcArgs {
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
			const extensionPath = takeValue(arg, index++);
			result.extensionPaths.push(extensionPath);
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
		if (arg === "--no-color") continue;
		throw new Error(`Unknown Runtime RPC option: ${arg}`);
	}
	if (result.provider && !result.model) throw new Error("--provider requires --model");
	if (result.noSession && result.continueSession) throw new Error("--continue cannot be combined with --no-session");
	if (result.disableExtensionDiscovery && result.extensionPaths.length > 0) {
		throw new Error("--no-extensions cannot be combined with --extension");
	}
	return result;
}

export async function runRuntimeRpcHost(argv: readonly string[]): Promise<never> {
	const input = claimRpcInput();
	const parsed = parseRuntimeRpcArgs(argv);
	const cwd = process.cwd();
	const eventBus = new EventBus();
	const settings = await Settings.loadIsolated({ cwd });
	applyRpcDefaultSettingOverrides(settings);
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const sessionManager = parsed.noSession
		? SessionManager.inMemory(cwd)
		: parsed.continueSession
			? await SessionManager.continueRecent(cwd, parsed.sessionDir)
			: SessionManager.create(cwd, parsed.sessionDir);
	const modelPattern = parsed.model
		? parsed.provider
			? `${parsed.provider}/${parsed.model}`
			: parsed.model
		: undefined;
	if (parsed.disableTitle) Bun.env.PI_NO_TITLE = "1";
	const { session, setToolUIContext } = await createAgentSession({
		cwd,
		eventBus,
		hasUI: false,
		modelPattern,
		modelRegistry,
		sessionManager,
		settings,
		providerSessionId: parsed.providerSessionId,
		providerPromptCacheKey: parsed.providerPromptCacheKey,
		providerPromptCacheKeySource: parsed.providerPromptCacheKey ? "explicit" : undefined,
		customSystemPrompt: parsed.customSystemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		thinkingLevel: parsed.thinkingLevel,
		toolNames: parsed.toolNames,
		disableExtensionDiscovery: parsed.disableExtensionDiscovery,
		additionalExtensionPaths: parsed.extensionPaths,
		skills: parsed.disableSkills ? [] : undefined,
		rules: parsed.disableRules ? [] : undefined,
		enableLsp: parsed.disableLsp ? false : undefined,
		autoApprove: parsed.autoApprove,
	});
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			settings,
		});
		if (resolved.error) {
			await session.dispose();
			throw new Error(resolved.error);
		}
	}
	return runRpcMode(session, setToolUIContext, eventBus, input, forwardAllRpcSessionEvents);
}

if (import.meta.main) {
	runRuntimeRpcHost(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
