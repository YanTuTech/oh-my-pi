import { prompt } from "@oh-my-pi/pi-utils";
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const ORCHESTRATE_WORD = magicKeywordRegex("orchestrate");

export function renderOrchestrateNotice(options: { tools: readonly string[] }): string {
	return prompt.render(orchestrateNotice, { tools: options.tools }).trim();
}

export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}
