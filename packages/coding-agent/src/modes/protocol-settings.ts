import { getDefault, type SettingPath, type Settings } from "../config/settings";

// Todo settings remain caller-controlled in protocol hosts. Embedders need
// project-level opt-outs for reminder and prelude prompt injection.
const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"task.isolation.mode",
	"task.isolation.apply",
	"task.isolation.merge",
	"task.isolation.commits",
	"task.eager",
	"task.batch",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.disabledAgents",
	"task.agentModelOverrides",
	"task.agentPrewalk",
	"task.agentAdvisor",
	"memory.backend",
	"memories.enabled",
	"advisor.enabled",
	"advisor.syncBacklog",
	"advisor.immuneTurns",
	"tier.advisor",
];

const RPC_BACKGROUND_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
	"eval.autoBackground.enabled",
	"eval.autoBackground.thresholdMs",
];

function applyDefaultSettingOverrides(settingPaths: SettingPath[], targetSettings: Settings): void {
	for (const settingPath of settingPaths) {
		if (targetSettings.isConfigured(settingPath)) continue;
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

/** Apply neutral protocol-host defaults without replacing caller configuration. */
export function applyAcpDefaultSettingOverrides(targetSettings: Settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
}

/** Apply neutral host and background-job defaults for RPC sessions. */
export function applyRpcDefaultSettingOverrides(targetSettings: Settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
	applyDefaultSettingOverrides(RPC_BACKGROUND_DEFAULTED_SETTING_PATHS, targetSettings);
}
