import type { RpcCommand, RpcManagedRuntimeAttestationV1, RpcManagedRuntimeLaunchBindingV1 } from "./rpc-types";

const MANAGED_RUNTIME_ALLOWED_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"negotiate_protocol",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"get_state",
	"set_fast_mode",
	"set_todos",
	"set_host_tools",
	"set_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"get_session_stats",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_messages_page",
]);

/**
 * Return whether a command belongs to the fail-closed RPC surface used by a
 * host-managed Runtime. Commands that discover or execute ambient host
 * capabilities stay unavailable even when ordinary RPC mode supports them.
 */
export function isManagedRuntimeCommandAllowed(type: RpcCommand["type"]): boolean {
	return MANAGED_RUNTIME_ALLOWED_COMMANDS.has(type);
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function validateManagedRuntimeLaunchBinding(
	binding: RpcManagedRuntimeLaunchBindingV1,
): RpcManagedRuntimeLaunchBindingV1 {
	if (binding.contractVersion !== 1 || binding.protocolEpoch !== 1) {
		throw new Error("Managed Runtime launch binding version is unsupported");
	}
	for (const [name, value] of [
		["runtimeBundleDigest", binding.runtimeBundleDigest],
		["buildGraphDigest", binding.buildGraphDigest],
		["capabilityRegistryDigest", binding.capabilityRegistryDigest],
		["launchTicketDigest", binding.launchTicketDigest],
		["channelBindingDigest", binding.channelBindingDigest],
	] as const) {
		if (!DIGEST_PATTERN.test(value)) throw new Error(`Managed Runtime ${name} must be a SHA-256 digest`);
	}
	if (!Number.isSafeInteger(binding.workerGeneration) || binding.workerGeneration < 1) {
		throw new Error("Managed Runtime workerGeneration must be a positive safe integer");
	}
	if (!Number.isSafeInteger(binding.policyGeneration) || binding.policyGeneration < 0) {
		throw new Error("Managed Runtime policyGeneration must be a non-negative safe integer");
	}
	return binding;
}

const requireEnvironmentValue = (environment: Record<string, string | undefined>, key: string): string => {
	const value = environment[key];
	if (!value) throw new Error(`Managed Runtime environment is missing ${key}`);
	return value;
};

const parseGeneration = (environment: Record<string, string | undefined>, key: string): number => {
	const value = requireEnvironmentValue(environment, key);
	if (!/^\d+$/.test(value)) throw new Error(`Managed Runtime ${key} is invalid`);
	return Number(value);
};

export function readManagedRuntimeAttestation(
	environment: Record<string, string | undefined>,
	processId: number,
): RpcManagedRuntimeAttestationV1 {
	const binding = validateManagedRuntimeLaunchBinding({
		contractVersion: 1,
		protocolEpoch: 1,
		runtimeBundleDigest: requireEnvironmentValue(environment, "OMP_MANAGED_RUNTIME_BUNDLE_DIGEST"),
		buildGraphDigest: requireEnvironmentValue(environment, "OMP_MANAGED_BUILD_GRAPH_DIGEST"),
		capabilityRegistryDigest: requireEnvironmentValue(environment, "OMP_MANAGED_CAPABILITY_REGISTRY_DIGEST"),
		launchTicketDigest: requireEnvironmentValue(environment, "OMP_MANAGED_LAUNCH_TICKET_DIGEST"),
		channelBindingDigest: requireEnvironmentValue(environment, "OMP_MANAGED_CHANNEL_BINDING_DIGEST"),
		workerGeneration: parseGeneration(environment, "OMP_MANAGED_WORKER_GENERATION"),
		policyGeneration: parseGeneration(environment, "OMP_MANAGED_POLICY_GENERATION"),
	});
	return {
		...binding,
		processId,
		nativeTools: false,
		hostToolsMutable: false,
		ambientDiscovery: false,
		modelTransport: "unix-domain-socket",
	};
}
