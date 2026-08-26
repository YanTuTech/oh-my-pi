import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const WORKFLOW_WORD = magicKeywordRegex("workflowz");

export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
}: {
	taskBatch: boolean;
	scoutAvailable?: boolean;
}): string {
	return prompt.render(workflowNoticeTemplate, { taskBatch, scoutAvailable: scoutAvailable ?? true }).trim();
}

export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}
