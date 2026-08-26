import type { FileDiagnosticsResult } from "../lsp";
import type { OutputMeta } from "../tools/output-meta";
import type { Operation } from "./modes/patch";

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	displayErrorText?: string;
	meta?: OutputMeta;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	sourcePath?: string;
}

export interface EditToolDetails {
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	meta?: OutputMeta;
	perFileResults?: EditToolPerFileResult[];
	path?: string;
	oldText?: string;
	newText?: string;
	snapshotsPruned?: boolean;
	sourcePath?: string;
}
