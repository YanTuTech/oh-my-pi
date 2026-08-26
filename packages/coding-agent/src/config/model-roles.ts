/**
 * Built-in model roles and role metadata helpers.
 */

import type { Settings } from "./settings";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Format a model role as its canonical selector. */
export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "designer"
	| "commit"
	| "tiny"
	| "task"
	| "advisor";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	/** If true, the role remains functional but is excluded from model cycling. */
	hidden?: boolean;
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default" },
	smol: { tag: "SMOL", name: "Fast" },
	slow: { tag: "SLOW", name: "Thinking" },
	vision: { tag: "VISION", name: "Vision" },
	plan: { tag: "PLAN", name: "Architect" },
	designer: { tag: "DESIGNER", name: "Designer" },
	commit: { tag: "COMMIT", name: "Commit" },
	tiny: { tag: "TINY", name: "Tiny" },
	task: { tag: "TASK", name: "Subtask" },
	advisor: { tag: "ADVISOR", name: "Advisor" },
};

export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"tiny",
	"task",
	"advisor",
];

/**
 * Return the canonical set of known roles for runtime model cycling.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role as ModelRole]?.hidden) as string[];
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) addRole(role);
	for (const role in settings.getModelRoles()) addRole(role);
	for (const role in settings.get("modelTags")) addRole(role);

	return roles;
}
