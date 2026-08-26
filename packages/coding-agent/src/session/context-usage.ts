import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { Skill } from "../extensibility/skills";
import type { Tool } from "../tools/runtime";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings, type SnapcompactSavingsEstimate } from "./snapcompact-inline";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Estimated snapcompact wire savings; set when requested and a snapcompact.* setting is enabled. */
	snapcompact?: SnapcompactSavingsEstimate;
}

/** Percent positions (0–100 of the context window) for the auto-compaction boundaries. */
export interface CompactionBoundaries {
	/** Where auto-compaction fires. */
	thresholdPercent: number;
	/**
	 * Where the background speculative summarizer starts (threshold − lead), or
	 * `null` when no speculation will run (async compaction disabled, or the
	 * first available method is local — snapcompact/shake — and thus instant).
	 */
	speculationPercent: number | null;
}

/**
 * Boundary positions for the status line's annotated context gauge. `null`
 * when compaction is disabled/off or the window is unknown — the gauge then
 * renders without markers. `model` resolves which configured method a real
 * pass would run; without it, model-gated methods count as unavailable.
 */
export function computeCompactionBoundaries(
	settings: AgentSession["settings"],
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = settings.getGroup("compaction");
	const compactionSettings = configured as CompactionSettings;
	if (!configured.enabled || compactionSettings.strategy === "off") return null;
	const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
	if (!(thresholdTokens > 0) || thresholdTokens > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	const leadTokens = resolveSpeculationLeadTokens(thresholdTokens);
	return {
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		speculationPercent: speculates ? (Math.max(0, thresholdTokens - leadTokens) / contextWindow) * 100 : null,
	};
}

/** Stable inputs used to cache non-message token estimates. */
export interface NonMessageTokenSource {
	readonly systemPrompt?: string[];
	readonly agent?: {
		readonly state?: {
			readonly tools?: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
		};
	};
	readonly skills?: readonly Skill[];
}

const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">> = [];
const EMPTY_SKILLS: readonly Skill[] = [];

/**
 * Skills actually rendered into the system prompt, mirroring the filter in
 * `buildSystemPrompt` (`system-prompt.ts`): the `read` tool must be present so
 * the model can fetch skill content, and skills with frontmatter `hide: true`
 * (or `disable-model-invocation`, normalized onto `hide`) are excluded.
 * Accounting must count only these so the Skills category and the System-prompt
 * subtraction stay aligned with the provider-facing prompt.
 */
function renderedSkills(
	skills: readonly Skill[],
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
): readonly Skill[] {
	if (!tools.some(tool => tool.name === "read")) return EMPTY_SKILLS;
	return skills.filter(skill => skill.hide !== true);
}

export function estimateSkillsTokens(skills: readonly Skill[], tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description ?? "");
	}
	return tokenizer.countTokens(fragments);
}

export function estimateToolSchemaTokens(
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
	tokenizer: Tokenizer,
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		// Extension-supplied tools may carry a non-string name/description or a
		// parameters value whose wire schema stringifies to `undefined` (e.g. a
		// callable schema that escaped normalization). A non-string fragment is
		// fatal inside the native tokenizer, so only real strings are counted.
		if (typeof tool.name === "string") fragments.push(tool.name);
		if (typeof tool.description === "string") fragments.push(tool.description);
		try {
			const wireTool: AiTool = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as AiTool["parameters"],
			};
			const wireJson = JSON.stringify(toolWireSchema(wireTool) ?? {});
			if (typeof wireJson === "string") fragments.push(wireJson);
		} catch {
			// Schema may contain functions or cycles; ignore.
		}
	}
	return tokenizer.countTokens(fragments);
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills.
 *
 * Exposed so host consumers can cache the non-message
 * total separately from the message total. Non-message inputs (skills,
 * tools, system prompt) change rarely; the message list grows on every
 * streaming turn. Splitting the two lets the caller refresh each on its own
 * cadence — non-message recomputed only when the inputs identity changes,
 * messages walked incrementally as new entries append.
 */
// Non-message inputs (system prompt, tools, skills) change rarely — at most
// once per turn via setSystemPrompt/setTools — but the per-turn compaction and
// threshold paths call these helpers several times: getContextBreakdown calls
// both, and #estimateStoredContextTokens adds a third. Memoize on the identity
// of the three input arrays so the expensive parts (system-prompt tokenization
// and the per-tool JSON.stringify(toolWireSchema) inside estimateToolSchemaTokens)
// run at most once per input change rather than per call. The identity keys are
// the same stable references host caches already trust
// (setSystemPrompt/setTools replace the array reference rather than mutating it).
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
	skillsRef: readonly Skill[];
	// The Agent swaps its Tokenizer instance when the model's encoding changes,
	// so instance identity doubles as the encoding key.
	tokenizerRef: Tokenizer;
	tokens: number | undefined;
	breakdown:
		| {
				skillsTokens: number;
				toolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
		  }
		| undefined;
}

const NON_MESSAGE_TOKEN_CACHE = Symbol("non-message-token-cache");

interface CachedNonMessageTokenSource extends NonMessageTokenSource {
	[NON_MESSAGE_TOKEN_CACHE]?: NonMessageTokenCache;
}

function nonMessageTokenCacheEntry(session: NonMessageTokenSource, tokenizer: Tokenizer): NonMessageTokenCache {
	const cachedSession: CachedNonMessageTokenSource = session;
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsRef = session.skills ?? EMPTY_SKILLS;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.skillsRef === skillsRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = { systemPromptRef, toolsRef, skillsRef, tokenizerRef: tokenizer, tokens: undefined, breakdown: undefined };
	cachedSession[NON_MESSAGE_TOKEN_CACHE] = entry;
	return entry;
}

export function computeNonMessageTokens(session: NonMessageTokenSource, tokenizer: Tokenizer): number {
	const entry = nonMessageTokenCacheEntry(session, tokenizer);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const tokens =
		tokenizer.countTokens(Array.from(systemPromptParts, part => part ?? "")) +
		estimateToolSchemaTokens(tools, tokenizer);
	entry.tokens = tokens;
	return tokens;
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). Keep this category split stable:
 * the status-line fast path intentionally uses the equivalent collapsed total
 * in `computeNonMessageTokens`.
 */
export function computeNonMessageBreakdown(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session, tokenizer);
	if (entry.breakdown) return entry.breakdown;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsTokens = estimateSkillsTokens(renderedSkills(session.skills ?? EMPTY_SKILLS, tools), tokenizer);
	const toolsTokens = estimateToolSchemaTokens(tools, tokenizer);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = tokenizer.countTokens(Array.from(systemPromptParts.slice(1), part => part ?? ""));
	const systemPromptTokens = Math.max(0, tokenizer.countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	const model = session.model;
	const tokenizer = session.agent.tokenizer;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		// Category split needs a messages-only number, so this walk stays local:
		// an anchored total folds the system prompt and tool schemas into it.
		messagesTokens = tokenizer.countMessages(session.messages ?? []);
		const nonMessage = computeNonMessageBreakdown(session, tokenizer);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{
			id: "systemContext",
			label: "System context",
			tokens: systemContextTokens,
		},
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{
			id: "messages",
			label: "Messages",
			tokens: messagesTokens,
		},
	];

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	// Estimated wire savings from snapcompact inline imaging. Opt-in: only the
	// /context surfaces need it; other callers skip the extra token counting.
	let snapcompactSavings: SnapcompactSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = session.settings.get("snapcompact.systemPrompt");
		const renderToolResults = session.settings.get("snapcompact.toolResults");
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompactSavings = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: session.settings.get("snapcompact.shape") },
				model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		snapcompact: snapcompactSavings,
	};
}
