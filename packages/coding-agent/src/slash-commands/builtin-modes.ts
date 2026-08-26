import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { SlashCommandSpec } from "./runtime-types";

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return settings.get("extendedContext") ? "on" : "off";
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = settings.get("extendedContext");
	if (!arg || arg === "toggle") {
		const enabled = !current;
		settings.set("extendedContext", enabled);
		return `Extended context ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on") {
		settings.set("extendedContext", true);
		return "Extended context enabled.";
	}
	if (arg === "off") {
		settings.set("extendedContext", false);
		return "Extended context disabled.";
	}
	if (arg === "status") return `Extended context is ${formatExtendedContextStatus(settings)}.`;
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
async function formatComputerUseStatus(session: AgentSession): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEnabledToolNames().includes("computer");
	const model = session.model;
	const modelName = model ? formatModelString(model) : "none";
	const exposure = !enabled
		? "not exposed (disabled)"
		: !active
			? "not exposed (tool inactive)"
			: computerExposureMode(model);
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	const computerTool = active
		? (session.getToolByName("computer") as Pick<ComputerTool, "capabilities"> | undefined)
		: undefined;
	const capabilities = await computerTool?.capabilities();
	const capabilityStatus = capabilities
		? [
				`backend=${capabilities.backend}${capabilities.displayServer ? `/${capabilities.displayServer}` : ""}`,
				`capture=${capabilities.capture} (${capabilities.capturePermission})`,
				`input=${capabilities.input} (${capabilities.inputPermission})`,
				`ax=${capabilities.ax} (${capabilities.axPermission})`,
				`backgroundWindowInput=${capabilities.backgroundWindowInput}`,
				`deliveryModes=${capabilities.deliveryModes.join(",") || "none"}`,
			].join(", ")
		: "session not started";
	return [
		`Computer use: ${enabled ? "enabled" : "disabled"}`,
		`tool: ${active ? "active" : "inactive"}`,
		`exposure: ${exposure}`,
		`model: ${modelName}`,
		`configured: display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
		`capabilities: ${capabilityStatus}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle: flip the active tool slate first
 * (so a failed enable never leaves a stale settings override), then record the
 * runtime override — never `settings.set`, which would persist to settings.json.
 * Returns the operator feedback line.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const applied = await session.setComputerToolEnabled(enable);
	if (enable && !applied) {
		return "Computer use is unavailable in this session.";
	}
	session.settings.override("computer.enabled", enable);
	return enable
		? `Computer use enabled for this session. ${await formatComputerUseStatus(session)}`
		: "Computer use disabled for this session.";
}

/** Session-effective `/vision status` line. */
function formatVisionStatus(session: AgentSession): string {
	const { mode, active, model } = session.inspectImageState();
	const override = session.getInspectImageModeOverride();
	const modelObj = session.model;
	const capability = modelObj
		? modelObj.input.includes("image")
			? "native image input"
			: "no native image input"
		: "no active model";
	return [
		`inspect_image: ${active ? "active" : "inactive"}`,
		`mode: ${mode}${override ? " (session override)" : ""}`,
		...(override ? [`configured: ${session.settings.get("inspect_image.mode")}`] : []),
		`model: ${model ?? "none"} (${capability})`,
	].join(" · ");
}

/** Applies a `/vision` mode for this session and returns the operator feedback line. */
async function applyVisionMode(session: AgentSession, mode: InspectImageMode): Promise<string> {
	const applied = await session.setInspectImageMode(mode);
	if (!applied) {
		return "inspect_image is unavailable in this session.";
	}
	return `Vision mode: ${mode}. ${formatVisionStatus(session)}`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		description: "Plan, run, inspect, import, and compare OMP-native security scans",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "Create an immutable security scan plan" },
			{ name: "scan", description: "Start a planned or newly planned native scan" },
			{ name: "status", description: "Show native scan operation status" },
			{ name: "cancel", description: "Cancel a running native scan" },
			{ name: "scans", description: "List stored project security scans" },
			{ name: "show", description: "Render a scan or security:// resource" },
			{ name: "import", description: "Import SARIF or a Codex Security bundle" },
			{ name: "export", description: "Export a canonical bundle, SARIF, or report" },
			{ name: "validate", description: "Validate one finding with OMP-native tools" },
			{ name: "compare", description: "Compare finding lineage across two scans" },
			{ name: "disposition", description: "Set a finding disposition with rationale" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		description: "Open settings menu",
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
	},
	{
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
	},
	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
	},
	{
		name: "guided-goal",
		description: "Have the agent interview you in chat, then set up goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
	},
	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
	},
	{
		name: "switch",
		description: "Switch model for this session (same as alt+p)",
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
	},
	{
		name: "extended-context",
		description: "Toggle premium long-context windows",
		acpDescription: "Toggle extended context",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable premium long-context windows" },
			{ name: "off", description: "Use standard-pricing context windows" },
			{ name: "status", description: "Show extended context status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("Usage: /extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
	},
	{
		name: "computer",
		description: "Toggle the native computer-use tool for this session",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(await formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("Usage: /computer [on|off|status]", runtime);
		},
	},
	{
		name: "vision",
		description: "Control the inspect_image vision-delegation tool for this session",
		acpDescription: "Toggle vision delegation",
		acpInputHint: "[on|off|auto|status]",
		subcommands: [
			{ name: "on", description: "Always expose inspect_image this session" },
			{ name: "off", description: "Never expose inspect_image this session" },
			{ name: "auto", description: "Follow inspect_image.mode (auto hides it for vision-capable models)" },
			{ name: "status", description: "Show inspect_image status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatVisionStatus(runtime.session));
				return commandConsumed();
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				await runtime.output(await applyVisionMode(runtime.session, arg));
				return commandConsumed();
			}
			return usage("Usage: /vision [on|off|auto|status]", runtime);
		},
	},
	{
		name: "prewalk",
		description: "Switch to a fast/cheap model at the next action (works even without --prewalk)",
		acpDescription: "Prewalk at the next action",
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? `Model "${rolePattern}" not found`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`No API key for ${resolved.model.provider}/${resolved.model.id}`, runtime);
			}
			const armed = runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk on: switching to ${resolved.model.provider}/${resolved.model.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
];
