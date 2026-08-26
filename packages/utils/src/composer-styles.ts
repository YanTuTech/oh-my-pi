const BUILTIN_COMPOSER_STYLE_IDS: ReadonlySet<string> = new Set([
	"box",
	"claude",
	"pi",
	"borderless",
	"rule",
	"field",
	"rail",
]);

export function isBuiltinComposerStyle(id: string): boolean {
	return BUILTIN_COMPOSER_STYLE_IDS.has(id);
}
