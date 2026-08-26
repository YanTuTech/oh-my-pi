import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const ULTRATHINK_WORD = magicKeywordRegex("ultrathink");

export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}
