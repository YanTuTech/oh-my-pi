/** Headless worker-process entrypoint used by SDK and RPC embeddings. */
import { interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";
import { BLOB_BROKER_WORKER_ARG } from "./blob-broker/protocol";
import { startBlobBrokerFromEnvironment } from "./blob-broker/server";
import { startJsEvalProcess } from "./eval/js/process-entry";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "./eval/js/worker-protocol";
import { startDaemonBrokerFromEnvironment } from "./launch/broker";
import { DAEMON_BROKER_WORKER_ARG } from "./launch/protocol";
import { LSP_MUX_WORKER_ARG } from "./lsp/mux/protocol";
import { startLspMuxFromEnvironment } from "./lsp/mux/server";
import { MNEMOPI_EMBED_WORKER_ARG } from "./mnemopi/embed-client";
import { startMnemopiEmbedWorker } from "./mnemopi/embed-worker";
import { STT_WORKER_ARG } from "./stt/asr-client";
import { startSttWorker } from "./stt/asr-worker";
import { runIpcSubprocessWorker } from "./subprocess/ipc-worker-host";
import { TINY_WORKER_ARG } from "./tiny/title-client";
import { startTinyTitleWorker } from "./tiny/worker";
import { BROWSER_RELAY_WORKER_ARG } from "./tools/browser/relay/protocol";
import { startRelayServer } from "./tools/browser/relay/server";
import { TTS_WORKER_ARG } from "./tts/tts-client";
import { startTtsWorker } from "./tts/tts-worker";

export const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";

function readPort(args: readonly string[]): number {
	const index = args.indexOf("--port");
	const raw = index >= 0 ? args[index + 1] : undefined;
	const port = raw === undefined ? 0 : Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid browser relay port: ${raw}`);
	return port;
}

export async function runRuntimeWorkerHost(argv: readonly string[]): Promise<void> {
	const selector = argv[0];
	if (selector === TINY_WORKER_ARG) return runIpcSubprocessWorker(startTinyTitleWorker);
	if (selector === STT_WORKER_ARG) return runIpcSubprocessWorker(startSttWorker);
	if (selector === TTS_WORKER_ARG) return runIpcSubprocessWorker(startTtsWorker);
	if (selector === MNEMOPI_EMBED_WORKER_ARG) return runIpcSubprocessWorker(startMnemopiEmbedWorker);
	if (selector === JS_EVAL_PROCESS_ARG) {
		return runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(
			transport => startJsEvalProcess(transport, interceptUnhandledRejections),
			{ rethrowConnectedSendErrors: true },
		);
	}
	if (selector === DAEMON_BROKER_WORKER_ARG) return startDaemonBrokerFromEnvironment();
	if (selector === LSP_MUX_WORKER_ARG) return startLspMuxFromEnvironment();
	if (selector === BLOB_BROKER_WORKER_ARG) return startBlobBrokerFromEnvironment();
	if (selector === BROWSER_RELAY_WORKER_ARG) {
		const relay = startRelayServer({ port: readPort(argv.slice(1)) });
		process.stdout.write(`Runtime browser relay listening on http://127.0.0.1:${relay.port}\n`);
		return;
	}
	throw new Error(`Unknown Runtime worker selector: ${selector ?? "<missing>"}`);
}

if (import.meta.main) {
	runRuntimeWorkerHost(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
