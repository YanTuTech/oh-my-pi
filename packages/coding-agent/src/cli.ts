#!/usr/bin/env bun
/**
 * Internal worker host retained for Runtime subprocess and Worker dispatch.
 * This module intentionally exposes no user-facing commands or terminal UI.
 */
import { parentPort } from "node:worker_threads";
import { declareWorkerHostEntry, installWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { TERMINAL_OUTPUT_WORKER_ARG } from "./launch/terminal-output-worker-protocol";
import { runRuntimeWorkerHost } from "./runtime-worker-host";
import { COMPUTER_WORKER_ARG } from "./tools/computer/protocol";
import { startComputerWorker } from "./tools/computer/worker-entry";

const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";

async function dispatchWorker(argv: readonly string[]): Promise<void> {
	const selector = argv[0];
	if (!isWorkerHostSelector(selector)) throw new Error("This entrypoint only hosts Agent Runtime workers");
	if (selector === TAB_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return;
	}
	if (selector === COMPUTER_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		startComputerWorker();
		return;
	}
	if (selector === JS_EVAL_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return;
	}
	if (selector === TERMINAL_OUTPUT_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./launch/terminal-output-worker");
		return;
	}
	await runRuntimeWorkerHost(argv);
}

if (import.meta.main) declareWorkerHostEntry();
if (import.meta.main || !Bun.isMainThread) {
	dispatchWorker(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
