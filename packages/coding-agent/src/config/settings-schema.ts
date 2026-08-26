import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { DEFAULT_SHARE_URL } from "@oh-my-pi/pi-wire";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";
import type { BlobDestinationId } from "../blob-broker/destinations";
import { DEFAULT_RELAY_URL } from "../collab/protocol";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_VALUES } from "../live/voices";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-methods";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_VALUES } from "../stt/models";
import { STT_SUBMIT_TRIGGER_VALUES } from "../stt/submit-trigger";
import { AUTO_THINKING } from "../thinking";
import { TINY_MODEL_DEVICE_DEFAULT, TINY_MODEL_DEVICE_SETTING_VALUES } from "../tiny/device";
import { TINY_MODEL_DTYPE_DEFAULT, TINY_MODEL_DTYPE_SETTING_VALUES } from "../tiny/dtype";
import {
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import type { ImageProvider } from "../tools/image-providers";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_VALUES,
} from "../tts/models";
import { EDIT_MODES } from "../utils/edit-mode";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, type SearchProviderId } from "../web/search/types";
import {
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_VALUES,
} from "./service-tier";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("compaction.enabled", true)  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type ModelRoleStorage = "global" | "project";

export type ContextLineMode = "off" | "percentage" | "annotated" | "embedded";
export const CONTEXT_LINE_MODE_VALUES = ["off", "percentage", "annotated", "embedded"] as const;

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage"
	| "collab";

/** Marks a setting whose value must never be printed or exported implicitly. */
interface CredentialMarker {
	credential?: true;
}

interface BooleanDef extends CredentialMarker {
	type: "boolean";
	default: boolean | undefined;
}

interface StringDef extends CredentialMarker {
	type: "string";
	default: string | undefined;
}

interface NumberDef extends CredentialMarker {
	type: "number";
	default: number | undefined;
}

interface EnumDef<T extends readonly string[]> extends CredentialMarker {
	type: "enum";
	values: T;
	default: T[number];
}

interface ArrayDef<T> extends CredentialMarker {
	type: "array";
	default: T[];
}

interface RecordDef<T> extends CredentialMarker {
	type: "record";
	default: Record<string, T>;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["hub"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "glob",
		message: "Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) instead of nohup or background shell syntax so the process stays observable and managed.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) for services, watchers, and debuggers so other omp instances can observe and control them.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "hub",
		message: 'Use the `hub` tool (`op:"start"`) for watch mode so its output, input, and lifecycle stay managed.',
	},
];

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	setupVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `omp auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined, credential: true },

	autoResume: {
		type: "boolean",
		default: false,
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
	},
	"prewalk.enabled": {
		type: "boolean",
		default: false,
	},
	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 3,
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	"providers.maxInFlightRequests": {
		type: "record",
		default: EMPTY_NUMBER_RECORD,
	},

	"providers.openai-codex.codeMode": {
		type: "enum",
		values: ["off", "on", "auto"] as const,
		default: "off",
	},

	"providers.openai-codex.codeModeDirectTools": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
	},

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoleStorage: {
		type: "enum",
		values: ["global", "project"] as const,
		default: "global",
	},

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
	},

	"theme.light": {
		type: "string",
		default: "light",
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
	},
	// Composer
	"composer.shape": {
		type: "string",
		default: "box",
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
	},

	"statusLine.contextLine": {
		type: "enum",
		values: CONTEXT_LINE_MODE_VALUES,
		default: "embedded",
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
	},

	"statusLine.transparent": {
		type: "boolean",
		default: false,
	},
	"statusLine.compactThinkingLevel": {
		type: "boolean",
		default: false,
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
	},

	"images.urls.enabled": {
		type: "boolean",
		default: false,
	},

	"images.urls.backends": {
		type: "array",
		default: ["provider-files", "tailscale", "cloudflared", "litterbox"] as BlobDestinationId[],
	},

	"images.urls.options": {
		type: "record",
		default: {} as Partial<Record<BlobDestinationId, Record<string, unknown>>>,
	},

	"images.urls.credentials": {
		type: "record",
		default: {} as Partial<Record<BlobDestinationId, Record<string, string>>>,
		credential: true,
	},

	"images.urls.command": {
		type: "string",
		default: undefined,
	},

	"images.urls.publicBaseUrl": {
		type: "string",
		default: undefined,
	},

	"images.urls.ttlHours": {
		type: "number",
		default: 72,
	},

	"images.urls.bindHost": {
		type: "string",
		default: "127.0.0.1",
	},

	"images.urls.sshTarget": {
		type: "string",
		default: undefined,
	},

	"images.urls.sshRemotePort": {
		type: "number",
		default: 8787,
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
	},
	"tui.resizeScrollback": {
		type: "enum",
		values: ["append", "rebuild", "preserve"] as const,
		default: "rebuild",
	},

	"terminal.showProgress": {
		type: "boolean",
		default: false,
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
	},

	"tui.renderMermaid": {
		type: "boolean",
		default: true,
	},

	"tui.codexResetFireworks": {
		type: "boolean",
		default: false,
	},

	"tui.titleState": {
		type: "boolean",
		default: true,
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
	},
	"tui.tight": {
		type: "boolean",
		default: false,
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
	},

	"display.hideToolActivity": {
		type: "boolean",
		default: false,
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
	},

	"display.collapseCompacted": {
		type: "boolean",
		default: true,
	},

	showHardwareCursor: {
		type: "boolean",
		default: true,
	},

	"tui.imeSafeCursor": {
		type: "boolean",
		default: false,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING],
		default: "high",
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
	},
	proseOnlyThinking: {
		type: "boolean",
		default: true,
	},

	omitThinking: {
		type: "boolean",
		default: false,
	},

	externalThinking: {
		type: "boolean",
		default: false,
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
	},

	"model.loopGuard.toolCallReminder": {
		type: "boolean",
		default: true,
	},

	"model.toolCallLoopGuard.enabled": {
		type: "boolean",
		default: true,
	},

	"model.toolCallLoopGuard.threshold": {
		type: "number",
		default: 5,
	},

	"model.toolCallLoopGuard.exemptTools": {
		type: "array",
		default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
	},

	inlineToolDescriptors: {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
	},

	includeWorkspaceTree: {
		type: "boolean",
		default: false,
	},

	"workspace.additionalDirectories": {
		type: "array",
		default: [] as string[],
	},

	personality: {
		type: "enum",
		values: ["default", "friendly", "pragmatic", "none"] as const,
		default: "default",
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
	},

	topP: {
		type: "number",
		default: -1,
	},

	topK: {
		type: "number",
		default: -1,
	},

	minP: {
		type: "number",
		default: -1,
	},

	presencePenalty: {
		type: "number",
		default: -1,
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
	},

	textVerbosity: {
		type: "enum",
		values: ["low", "medium", "high"] as const,
		default: "medium",
	},

	"tier.openai": {
		type: "enum",
		values: SERVICE_TIER_OPENAI_VALUES,
		default: "none",
	},

	"tier.anthropic": {
		type: "enum",
		values: SERVICE_TIER_ANTHROPIC_VALUES,
		default: "none",
	},

	"tier.google": {
		type: "enum",
		values: SERVICE_TIER_GOOGLE_VALUES,
		default: "none",
	},

	"tier.subagent": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "inherit",
	},

	"tier.advisor": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "none",
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
	},
	"retry.usageAwareFallback": {
		type: "boolean",
		default: false,
	},
	"retry.usageReservePct": {
		type: "number",
		default: 10,
	},
	"retry.usageReservePolicy": {
		type: "enum",
		values: ["confirm", "auto", "fail-closed"] as const,
		default: "confirm",
	},
	"retry.fallbackChains": {
		type: "record",
		default: {} as Record<string, string[]>,
	},
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
	},

	"providers.anthropic.serverSideFallback": {
		type: "boolean",
		default: false,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 10,
	},

	"spelling.typoDetection": {
		type: "boolean",
		default: true,
	},

	"spelling.autocomplete": {
		type: "boolean",
		default: true,
	},

	"spelling.autocorrect": {
		type: "boolean",
		default: false,
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
	},

	"startup.showSplash": {
		type: "boolean",
		default: false,
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
	},
	"update.channel": {
		type: "enum",
		values: ["stable", "canary"] as const,
		default: "stable",
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
	},

	"startup.changelogMode": {
		type: "enum",
		values: ["summary", "expanded", "hidden"] as const,
		default: "summary",
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
	},

	"magicKeywords.orchestrate": {
		type: "boolean",
		default: true,
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
	},

	"error.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "off",
	},

	"ask.timeout": {
		type: "number",
		default: 0,
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
	},

	"recap.enabled": {
		type: "boolean",
		default: true,
	},

	"recap.idleSeconds": {
		type: "number",
		default: 240,
	},

	// Collab
	"collab.relayUrl": {
		type: "string",
		default: DEFAULT_RELAY_URL,
	},

	"collab.webUrl": {
		type: "string",
		default: "",
	},

	"collab.displayName": {
		type: "string",
		default: "",
	},

	"share.serverUrl": {
		type: "string",
		default: DEFAULT_SHARE_URL,
	},

	"share.store": {
		type: "enum",
		values: ["blob", "gist"] as const,
		default: "blob",
	},

	"share.redactSecrets": {
		type: "boolean",
		default: true,
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: STT_MODEL_VALUES,
		default: DEFAULT_STT_MODEL_KEY,
	},
	"stt.submitTrigger": {
		type: "enum",
		values: STT_SUBMIT_TRIGGER_VALUES,
		default: "never",
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
	},

	// Premium long-context tiers (OpenAI GPT-5.6 bills 2x input / 1.5x output
	// above 272K input tokens). Off caps affected models at the threshold so
	// compaction kicks in before any request crosses into premium billing.
	extendedContext: {
		type: "boolean",
		default: true,
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
	},

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
	},

	"compaction.methodOrder": {
		type: "array",
		default: [...DEFAULT_COMPACTION_METHOD_ORDER],
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
	},

	"compaction.remoteStreamingV2Enabled": {
		type: "boolean",
		default: true,
	},

	"compaction.asyncEnabled": {
		type: "boolean",
		default: true,
	},

	// No default: an unset reserve tells the compaction layer the user never
	// chose one, so small-window recovery may swap in the proportional reserve
	// (see resolveBudgetReserveTokens). A materialized 16384 here would make
	// every session look explicitly configured.
	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	"compaction.v2RetainedMessageBudget": { type: "number", default: 64000 },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
	},

	// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
	"snapcompact.systemPrompt": {
		type: "enum",
		values: ["none", "agents-md", "all"] as const,
		default: "none",
	},

	"snapcompact.toolResults": {
		type: "boolean",
		default: false,
	},

	"tools.format": {
		type: "enum",
		values: [
			"auto",
			"native",
			"glm",
			"hermes",
			"kimi",
			"xml",
			"anthropic",
			"deepseek",
			"harmony",
			"qwen3",
			"gemini",
			"gemma",
			"minimax",
		] as const,
		default: "auto",
	},

	"snapcompact.shape": {
		type: "enum",
		values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
		default: "auto",
	},

	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. The legacy
	// `memories.enabled` flag is migration input only; see config/settings.ts.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
	},

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
	},
	// Config-file-only knob (numbers without `options` are hidden from the UI).
	"autolearn.minToolCalls": { type: "number", default: 5 },

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
	},
	"mnemopi.embeddingVariant": {
		type: "enum",
		values: ["en", "multilingual"] as const,
		default: "en",
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
	},
	"mnemopi.polyphonicRecall": {
		type: "boolean",
		default: false,
	},
	"mnemopi.enhancedRecall": {
		type: "boolean",
		default: false,
	},
	"mnemopi.proactiveLinking": {
		type: "boolean",
		default: false,
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		credential: true,
		default: undefined,
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
	},
	"mnemopi.llmApiKey": {
		type: "string",
		credential: true,
		default: undefined,
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 8 },
	"mnemopi.recallContextTurns": { type: "number", default: 3 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 4000 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 5000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
	},

	"hindsight.apiToken": {
		type: "string",
		credential: true,
		default: undefined,
	},

	"hindsight.bankId": {
		type: "string",
		default: undefined,
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "omp" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.requestTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.reflectTimeoutMs": { type: "number", default: 120_000 },
	"hindsight.recallTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.retainTimeoutMs": { type: "number", default: 60_000 },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
	},

	"edit.enforceSeenLines": {
		type: "boolean",
		default: false,
	},
	"edit.blackbox.enabled": {
		type: "boolean",
		default: false,
	},
	"edit.autoRepair.enabled": {
		type: "boolean",
		default: false,
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
	},

	"read.renderMarkdown": {
		type: "boolean",
		default: false,
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
	},

	"lsp.lazy": {
		type: "boolean",
		default: true,
	},

	"lsp.shared": {
		type: "boolean",
		default: true,
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
	},

	"lsp.diagnosticsDeduplicate": {
		type: "boolean",
		default: true,
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: true,
	},
	"bash.patterns": {
		type: "array",
		default: [],
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.direnv": {
		type: "enum",
		values: ["auto", "off"] as const,
		default: "auto",
	},
	"bash.direnvLoadTimeoutMs": {
		type: "number",
		default: 30_000,
	},
	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
	},

	"eval.js": {
		type: "boolean",
		default: true,
	},

	"eval.rb": {
		type: "boolean",
		default: false,
	},

	"eval.jl": {
		type: "boolean",
		default: false,
	},

	"eval.autoBackground.enabled": {
		type: "boolean",
		default: false,
	},

	"eval.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	// Runtime knobs (consumed by eval backends and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
	},
	"python.interpreter": {
		type: "string",
		default: "",
	},
	"ruby.interpreter": {
		type: "string",
		default: "",
	},
	"julia.interpreter": {
		type: "string",
		default: "",
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
	//   "write"      — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"       — auto-approves every tier.
	"tools.approvalMode": {
		type: "enum",
		values: ["always-ask", "write", "yolo"] as const,
		default: "yolo",
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
	},

	"todo.remindersMax": {
		type: "number",
		default: 3,
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
	},

	// Grep, glob, and AST tools
	"glob.enabled": {
		type: "boolean",
		default: true,
	},

	"grep.enabled": {
		type: "boolean",
		default: true,
	},

	"grep.contextBefore": {
		type: "number",
		default: 1,
	},

	"grep.contextAfter": {
		type: "number",
		default: 3,
	},

	"astGrep.enabled": {
		type: "boolean",
		default: false,
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
	},

	// Optional tools

	"debug.enabled": {
		type: "boolean",
		default: true,
	},

	"launch.enabled": {
		type: "boolean",
		default: true,
	},

	"speechgen.enabled": {
		type: "boolean",
		default: false,
	},
	"generate_image.enabled": {
		type: "boolean",
		default: false,
	},

	// Legacy boolean kept only for back-compat migration to `inspect_image.mode`
	// (see config/settings.ts). Hidden from UI.
	"inspect_image.enabled": {
		type: "boolean",
		default: false,
	},

	"inspect_image.mode": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
	},

	"computer.enabled": {
		type: "boolean",
		default: false,
	},

	"computer.display": {
		type: "string",
		default: "all",
	},

	"computer.maxWidth": {
		type: "number",
		default: 3840,
	},

	"computer.maxHeight": {
		type: "number",
		default: 2400,
	},

	"inspect_image.timeoutMs": {
		type: "number",
		default: 300_000,
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
	},

	"github.enabled": {
		type: "boolean",
		default: false,
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
	},

	"security.enabled": {
		type: "boolean",
		default: false,
	},

	"ask.enabled": {
		type: "boolean",
		default: true,
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
	},

	"browser.cdpUrl": {
		type: "string",
		default: undefined,
	},

	"browser.relay": {
		type: "boolean",
		default: false,
	},

	"browser.relayUrl": {
		type: "string",
		default: undefined,
	},

	"browser.headless": {
		type: "boolean",
		default: true,
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: true,
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	"tools.xdev": {
		type: "boolean",
		default: true,
	},

	"tools.xdevDocs": {
		type: "enum",
		values: ["inline", "builtins", "catalog"] as const,
		default: "builtins",
	},

	"tools.xdevInlineDevices": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
	},

	"mcp.renderMarkdownResults": {
		type: "boolean",
		default: true,
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
	},

	"plan.defaultOnStartup": {
		type: "boolean",
		default: false,
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
	},

	"title.refreshOnReplan": {
		type: "boolean",
		default: true,
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
	},

	"task.isolation.apply": {
		type: "boolean",
		default: true,
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
	},

	"worktree.base": {
		type: "string",
		default: undefined,
	},

	"task.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
	},

	"task.batch": {
		type: "boolean",
		default: true,
	},

	"task.enableEffort": {
		type: "boolean",
		default: false,
	},

	"task.maxConcurrency": {
		type: "number",
		default: 32,
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
	},

	"task.agentIdleTtlMs": {
		type: "number",
		default: 420_000,
	},

	"task.softRequestBudget": {
		type: "number",
		default: 200,
	},

	"task.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
	},

	"task.maxEffort": {
		type: "enum",
		values: THINKING_EFFORTS,
		default: "max",
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: DEFAULT_AGENT_MODEL_OVERRIDES,
	},
	"task.agentPrewalk": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.agentAdvisor": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.prewalk": {
		type: "boolean",
		default: false,
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
	},

	"task.showResolvedModelBadge": {
		type: "boolean",
		default: false,
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.enableAgentsUser": { type: "boolean", default: true },

	"skills.enableAgentsProject": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
	},

	// Restrict file-based slash commands to matching "<provider>:<level>" entries.
	// An empty array preserves the current unrestricted behavior.
	"commands.fileCommandAllowlist": {
		type: "array",
		default: [] as string[],
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
	},

	// Provider selection
	"providers.ollama-cloud.maxConcurrency": {
		type: "number",
		default: 3,
	},
	"providers.webSearchOrder": {
		type: "array",
		default: [] as SearchProviderId[],
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
	},
	"providers.webSearchTimeoutSeconds": {
		type: "number",
		default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	},
	"providers.webSearchGeminiModel": {
		type: "string",
		default: undefined,
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
	},
	"providers.imageOrder": {
		type: "array",
		default: [] as ImageProvider[],
	},
	"providers.fireworksTier": {
		type: "enum",
		values: ["standard", "priority"] as const,
		default: "standard",
	},
	"live.voice": {
		type: "enum",
		values: LIVE_VOICE_VALUES,
		default: DEFAULT_LIVE_VOICE,
	},
	"providers.tts": {
		type: "enum",
		values: ["auto", "local", "xai", "deepinfra"] as const,
		default: "auto",
	},
	"tts.localModel": {
		type: "enum",
		values: TTS_LOCAL_MODEL_VALUES,
		default: DEFAULT_TTS_LOCAL_MODEL_KEY,
	},
	"tts.localVoice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
	},
	"speech.enabled": {
		type: "boolean",
		default: false,
	},
	"speech.mode": {
		type: "enum",
		values: ["all", "assistant", "yield"] as const,
		default: "assistant",
	},
	"speech.enhanced": {
		type: "boolean",
		default: false,
	},
	"speech.voice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
	},
	"providers.autoThinkingMaxEffort": {
		type: "enum",
		values: ["xhigh", "max"] as const,
		default: "xhigh",
	},
	"features.unexpectedStopDetection": {
		type: "enum",
		values: ["none", "mechanical", "smart"] as const,
		default: "mechanical",
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["auto", "openai", "anthropic"] as const,
		default: "auto",
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
	},

	"providers.cacheRetention": {
		type: "enum",
		values: ["auto", "short", "long", "none"] as const,
		default: "auto",
	},

	"providers.streamFirstEventTimeoutSeconds": {
		type: "number",
		default: -1,
	},

	"providers.streamIdleTimeoutSeconds": {
		type: "number",
		default: -1,
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
	},
	// Codex saved rate-limit resets (auto-redeem)
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
	},
	"codexResets.salvageHorizonHours": {
		type: "number",
		default: 12,
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
	},

	"exa.searchDelayMs": {
		type: "number",
		default: 1_000,
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
	},

	"searxng.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.engines": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"searxng.safesearch": {
		type: "number",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"extensionHandlers.toolCallTimeoutMs": {
		type: "number",
		default: 30_000,
	},

	"dev.autoqa": {
		type: "boolean",
		default: true,
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		default: "https://qa.omp.sh/v1/grievances" as const,
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via a
	 * process-global consent handler registered by an embedding host.
	 *
	 * @default "unset"
	 */
	"dev.autoqaConsent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"gc.blobs": { type: "boolean", default: true },

	"gc.archive": { type: "boolean", default: true },

	"gc.wal": { type: "boolean", default: true },

	"gc.coldArchiveAfterDays": { type: "number", default: 30 },

	"gc.retainNewestGlobal": { type: "number", default: 20 },

	"gc.retainNewestPerCwd": { type: "number", default: 10 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 32768 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number"; default: undefined }
				? number | undefined
				: Schema[P] extends { type: "number" }
					? number
					: Schema[P] extends { type: "enum"; values: infer V }
						? V extends readonly string[]
							? V[number]
							: never
						: Schema[P] extends { type: "array"; default: infer D }
							? D
							: Schema[P] extends { type: "record"; default: infer D }
								? D
								: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Whether a setting holds a credential and must never be printed or exported implicitly. */
export function isCredential(path: SettingPath): boolean {
	const def = SETTINGS_SCHEMA[path];
	return "credential" in def && def.credential === true;
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

/** Personality preset - derived from schema */
export type Personality = SettingValue<"personality">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	methodOrder: CompactionMethod[];
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	asyncEnabled: boolean;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEndpoint: string | undefined;
	remoteStreamingV2Enabled: boolean;
	v2RetainedMessageBudget: number;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
}

export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

export interface TitleSettings {
	refreshOnReplan: boolean;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
	usageAwareFallback: boolean;
	usageReservePct: number;
	usageReservePolicy: "confirm" | "auto" | "fail-closed";
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	enableAgentsUser?: boolean;
	enableAgentsProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	searchDelayMs: number;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	streaming: boolean;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}
export type CodexAutoRedeemMode = "unset" | "yes" | "no";

export interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
	salvageHorizonHours: number;
}

export interface GcSettings {
	blobs: boolean;
	archive: boolean;
	wal: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	recap: RecapSettings;
	title: TitleSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	gc: GcSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
