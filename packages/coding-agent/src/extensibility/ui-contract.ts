/**
 * Structural compatibility types for extension APIs that can be hosted over
 * RPC without loading a terminal renderer. They intentionally contain no TUI
 * implementation and no terminal side effects.
 */

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	icon?: string;
	hint?: string;
}

export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void };
}

export interface Component {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
	wantsKeyRelease?: boolean;
	invalidate?(): void;
	setIgnoreTight?(ignore: boolean): unknown;
	dispose?(): void;
}

export interface TUI {
	requestRender(): void;
}

export type KeyId = string;

export interface KeybindingsManager {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): KeyId[];
}

export interface EditorTheme {
	borderColor: (text: string) => string;
	accentColor?: (text: string) => string;
	surfaceColor?: (text: string) => string;
}

export interface ComposerStyle {
	readonly id: string;
}

export type SizeValue = number | `${number}%`;

export interface OverlayOptions {
	width?: SizeValue;
	minWidth?: number;
	maxHeight?: SizeValue;
	anchor?:
		| "center"
		| "top-left"
		| "top-right"
		| "bottom-left"
		| "bottom-right"
		| "top-center"
		| "bottom-center"
		| "left-center"
		| "right-center";
	offsetX?: number;
	offsetY?: number;
	row?: SizeValue;
	col?: SizeValue;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	visible?: (termWidth: number, termHeight: number) => boolean;
	fullscreen?: boolean;
	mouseTracking?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
}

export type ThemeColor = string;

export interface Theme {
	fg(color: ThemeColor, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	styledSymbol(name: string, fallback?: string): string;
	symbol(name: string): string;
	icon(name: string): string;
	readonly spinnerFrames: string[];
	getFgAnsi(color: ThemeColor): string;
	getColorMode(): string;
	getMajorThemeColorHexes(): string[];
	getThinkingBorderColor(level?: unknown): string;
	getBashModeBorderColor(mode?: unknown): string;
	getPythonModeBorderColor(mode?: unknown): string;
	getLangIcon(language: string): string;
	readonly accentSurfaceLuminance?: number;
	readonly format: Record<string, string>;
	readonly status: Record<string, string>;
	readonly boxRound: Record<string, string>;
	readonly checkbox: Record<string, string>;
	readonly tree: Record<string, string>;
	readonly sep: Record<string, string>;
}

const plain = (text: string): string => text;

/** Plain-text theme used only to satisfy legacy extension callbacks in headless hosts. */
export const runtimeTheme: Theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: plain,
	dim: plain,
	italic: plain,
	underline: plain,
	inverse: plain,
	strikethrough: plain,
	styledSymbol: (_name, fallback = "") => fallback,
	symbol: () => "",
	icon: () => "",
	spinnerFrames: [""],
	getFgAnsi: () => "",
	getColorMode: () => "none",
	getMajorThemeColorHexes: () => [],
	getThinkingBorderColor: () => "",
	getBashModeBorderColor: () => "",
	getPythonModeBorderColor: () => "",
	getLangIcon: () => "",
	format: {},
	status: {},
	boxRound: {},
	checkbox: {},
	tree: {},
	sep: {},
};
