import {
	Ellipsis,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
} from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH } from "./tab-spacing";

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	maxWidth = Math.max(0, maxWidth | 0);
	if (!pad && text.length * 3 <= maxWidth) return text;
	return nativeTruncateToWidth(
		text,
		maxWidth,
		(typeof ellipsisKind === "string" ? Ellipsis.Omit : ellipsisKind) ?? Ellipsis.Unicode,
		pad ?? false,
		DEFAULT_TAB_WIDTH,
	);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return nativeWrapTextWithAnsi(text, width, DEFAULT_TAB_WIDTH);
}

const SPACE_BUFFER = " ".repeat(512);
const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}
