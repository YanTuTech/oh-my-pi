/** Headless process entrypoint for {@link RpcClient}. */

import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "./config/model-registry";
import { resolveCliModel } from "./config/model-resolver";
import { Settings } from "./config/settings";
import { applyRpcDefaultSettingOverrides } from "./modes/protocol-settings";
import { createManagedModelBrokerStreamFn } from "./modes/rpc/managed-model-broker";
import { readManagedRuntimeAttestation } from "./modes/rpc/managed-runtime";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { forwardAllRpcSessionEvents, runRpcMode } from "./modes/rpc/rpc-mode";
import { parseRuntimeRpcArgs } from "./runtime-rpc-args";
import { createAgentSession, discoverAuthStorage } from "./sdk";
import { SessionManager } from "./session/session-manager";
import { EventBus } from "./utils/event-bus";

export async function runRuntimeRpcHost(argv: readonly string[]): Promise<never> {
	const input = claimRpcInput();
	const parsed = parseRuntimeRpcArgs(argv);
	const cwd = process.cwd();
	const eventBus = new EventBus();
	const settings = parsed.managedRuntime
		? Settings.isolated({
				includeWorkspaceTree: false,
				"providers.openaiWebsockets": "off",
				"power.sleepPrevention": "off",
				"retry.enabled": false,
				"retry.modelFallback": false,
				"retry.usageAwareFallback": false,
			})
		: await Settings.loadIsolated({ cwd });
	applyRpcDefaultSettingOverrides(settings);
	const brokerSocket = parsed.managedRuntime ? Bun.env.OMP_MANAGED_MODEL_BROKER_SOCKET : undefined;
	const managedRuntimeAttestation = parsed.managedRuntime
		? readManagedRuntimeAttestation(Bun.env, process.pid)
		: undefined;
	if (parsed.managedRuntime) {
		if (!parsed.provider || !parsed.model) {
			throw new Error("Managed Runtime requires a host-selected provider and model");
		}
		if (!parsed.sessionDir || !path.isAbsolute(parsed.sessionDir)) {
			throw new Error("Managed Runtime requires an absolute session directory");
		}
		if (!brokerSocket || !path.isAbsolute(brokerSocket)) {
			throw new Error("Managed Runtime requires an absolute model broker socket path");
		}
	}
	const authStorage = parsed.managedRuntime
		? await AuthStorage.create(path.join(parsed.sessionDir as string, "managed-auth.db"), {
				configValueResolver: async () => undefined,
				sourceLabel: "managed-runtime",
			})
		: await discoverAuthStorage();
	if (parsed.managedRuntime) authStorage.setRuntimeApiKey(parsed.provider as string, "managed-model-broker");
	const modelRegistry = new ModelRegistry(authStorage, undefined, {
		ignoreLocalModelConfig: parsed.managedRuntime,
		settings,
		cacheDbPath: parsed.managedRuntime ? path.join(parsed.sessionDir as string, "managed-model-cache.db") : undefined,
		fetch: parsed.managedRuntime
			? () => Promise.reject(new Error("Managed Runtime model discovery network is disabled"))
			: undefined,
	});
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
	if (parsed.managedRuntime || parsed.disableTitle) Bun.env.PI_NO_TITLE = "1";
	const { session, setToolUIContext } = await createAgentSession({
		cwd,
		eventBus,
		hasUI: false,
		modelPattern,
		modelRegistry,
		sessionManager,
		settings,
		agentDir: parsed.managedRuntime ? path.join(parsed.sessionDir as string, "agent") : undefined,
		managedRuntime: parsed.managedRuntime,
		additionalDirectories: parsed.managedRuntime ? [] : undefined,
		fileMentionReadPolicy: parsed.managedRuntime ? { mode: "disabled" } : undefined,
		contextFiles: parsed.managedRuntime ? [] : undefined,
		workspaceTree: parsed.managedRuntime
			? { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] }
			: undefined,
		promptTemplates: parsed.managedRuntime ? [] : undefined,
		slashCommands: parsed.managedRuntime ? [] : undefined,
		providerSessionId: parsed.providerSessionId,
		providerPromptCacheKey: parsed.providerPromptCacheKey,
		providerPromptCacheKeySource: parsed.providerPromptCacheKey ? "explicit" : undefined,
		customSystemPrompt: parsed.customSystemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		thinkingLevel: parsed.thinkingLevel,
		getApiKey: parsed.managedRuntime ? () => "managed-model-broker" : undefined,
		streamFn: parsed.managedRuntime ? createManagedModelBrokerStreamFn(brokerSocket as string) : undefined,
		toolNames: parsed.managedRuntime ? [] : parsed.toolNames,
		disableExtensionDiscovery: parsed.managedRuntime || parsed.disableExtensionDiscovery,
		additionalExtensionPaths: parsed.managedRuntime ? [] : parsed.extensionPaths,
		skills: parsed.managedRuntime || parsed.disableSkills ? [] : undefined,
		rules: parsed.managedRuntime || parsed.disableRules ? [] : undefined,
		enableLsp: parsed.managedRuntime || parsed.disableLsp ? false : undefined,
		enableMCP: parsed.managedRuntime ? false : undefined,
		enableIrc: parsed.managedRuntime ? false : undefined,
		restrictToolNames: parsed.managedRuntime ? true : undefined,
		allowRestrictedCustomTools: parsed.managedRuntime ? false : undefined,
		autoApprove: parsed.managedRuntime ? false : parsed.autoApprove,
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
	return runRpcMode(session, setToolUIContext, eventBus, input, {
		...forwardAllRpcSessionEvents,
		managedRuntime: managedRuntimeAttestation,
	});
}

if (import.meta.main) {
	runRuntimeRpcHost(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
