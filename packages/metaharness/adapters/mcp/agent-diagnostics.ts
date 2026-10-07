import type { FetchImpl } from "@oh-my-pi/pi-utils";
import {
	type AgentDiagnostics,
	type DiagnosticPhase,
	type HttpAttemptTiming,
	isRecord,
	type RequestPhase,
	type RequestTiming,
} from "./agent-protocol";

/** Bounded phase timing for one trial. Observers never retain provider payloads or credentials. */
export class DiagnosticRecorder {
	readonly data: AgentDiagnostics = {
		version: 1,
		phase: "setup",
		elapsedMs: 0,
		setupMs: null,
		promptMs: null,
		sessionDisposeMs: null,
		mcpDisconnectMs: null,
		requests: [],
		tools: [],
		timeout: null,
		cleanupErrors: [],
	};
	readonly #clock: () => number;
	readonly #started: number;
	#promptStarted: number | undefined;

	constructor(clock: () => number = () => performance.now()) {
		this.#clock = clock;
		this.#started = clock();
	}

	elapsed(): number {
		const elapsed = Math.max(0, this.#clock() - this.#started);
		this.data.elapsedMs = Math.max(this.data.elapsedMs, elapsed);
		return this.data.elapsedMs;
	}

	phase(value: DiagnosticPhase): void {
		this.data.phase = value;
		this.elapsed();
	}

	beginPrompt(): void {
		this.#promptStarted = this.elapsed();
		this.data.setupMs = this.#promptStarted;
		this.phase("between-requests");
	}

	endPrompt(): void {
		if (this.#promptStarted !== undefined) this.data.promptMs = this.elapsed() - this.#promptStarted;
	}

	beginRequest(): RequestTiming {
		const request: RequestTiming = {
			index: this.data.requests.length + 1,
			startedMs: this.elapsed(),
			payloadReadyMs: null,
			responseHeadersMs: null,
			firstSseMs: null,
			firstContentMs: null,
			lastSseMs: null,
			endedMs: null,
			responseCount: 0,
			httpAttempts: [],
			sseCount: 0,
			status: null,
			outcome: "pending",
		};
		this.data.requests.push(request);
		this.phase("model");
		return request;
	}

	/** Payload preparation precedes fetch; this is NOT proof of transmitted bytes. */
	payloadReady(request: RequestTiming): void {
		request.payloadReadyMs ??= this.elapsed();
	}

	observeFetch(request: RequestTiming, implementation: FetchImpl, beforeFetch: () => void): FetchImpl {
		const observed: FetchImpl = async (input, init) => {
			beforeFetch();
			request.httpAttempts ??= [];
			const attempts = request.httpAttempts;
			const attempt: HttpAttemptTiming = {
				index: attempts.length + 1,
				startedMs: this.elapsed(),
				headersMs: null,
				endedMs: null,
				status: null,
				requestId: null,
				errorCode: null,
				outcome: "pending",
			};
			attempts.push(attempt);
			try {
				const response = await implementation(input, init);
				attempt.headersMs = this.elapsed();
				attempt.status = response.status;
				const id = response.headers.get("x-request-id") ?? response.headers.get("request-id");
				attempt.requestId = id && /^[a-zA-Z0-9._:-]{1,128}$/.test(id) ? id : null;
				attempt.outcome = "response";
				return response; // No body consumption, no header or payload persistence.
			} catch (error) {
				const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
				attempt.outcome = signal?.aborted ? "aborted" : "network-error";
				const code = isRecord(error) ? error.code : undefined;
				if (
					typeof code === "string" &&
					[
						"ABORT_ERR",
						"ECONNRESET",
						"ECONNREFUSED",
						"ETIMEDOUT",
						"ENOTFOUND",
						"EAI_AGAIN",
						"UND_ERR_CONNECT_TIMEOUT",
					].includes(code)
				)
					attempt.errorCode = code;
				throw error;
			} finally {
				attempt.endedMs = this.elapsed();
			}
		};
		observed.preconnect = implementation.preconnect;
		return observed;
	}

	response(request: RequestTiming, status: number): void {
		request.responseHeadersMs ??= this.elapsed();
		request.responseCount += 1;
		request.status = status;
	}

	sse(request: RequestTiming): void {
		const elapsed = this.elapsed();
		request.firstSseMs ??= elapsed;
		request.lastSseMs = elapsed;
		request.sseCount += 1;
	}

	content(): void {
		const request = this.data.requests.at(-1);
		if (request && request.endedMs === null) request.firstContentMs ??= this.elapsed();
	}

	endRequest(outcome: RequestTiming["outcome"]): void {
		const request = this.data.requests.at(-1);
		if (!request || request.endedMs !== null) return;
		request.endedMs = this.elapsed();
		request.outcome = outcome;
		this.phase("between-requests");
	}

	beginTool(callIndex: number): () => void {
		const tool = { callIndex, startedMs: this.elapsed(), endedMs: null as number | null };
		this.data.tools.push(tool);
		this.phase("tools");
		return () => {
			tool.endedMs = this.elapsed();
			if (this.data.tools.every(item => item.endedMs !== null)) this.phase("between-requests");
		};
	}

	/** Capture before abort changes the live phase. A later cleanup failure cannot overwrite this. */
	timeout(): void {
		if (this.data.timeout) return;
		const request = this.data.requests.at(-1);
		let requestPhase: RequestPhase | null = null;
		if (this.data.phase === "model" && request) {
			requestPhase =
				request.endedMs !== null
					? "finished"
					: request.firstSseMs !== null
						? "streaming"
						: request.responseHeadersMs !== null
							? "waiting-stream-event"
							: request.payloadReadyMs !== null
								? "waiting-response-headers"
								: "preparing-request";
		}
		// An SDK callback may never fire while the HTTP layer retries 429/5xx.
		// Keep that distinct from never observing any response at fetch level.
		if (
			requestPhase === "waiting-response-headers" &&
			request?.httpAttempts?.some(attempt => attempt.status !== null)
		)
			requestPhase = "transport-retry-or-error";
		this.data.timeout = {
			phase: this.data.phase,
			requestPhase,
			requestIndex: requestPhase === null ? null : (request?.index ?? null),
			elapsedMs: this.elapsed(),
		};
	}

	async cleanup(phase: "session-dispose" | "mcp-disconnect", operation: () => Promise<void>): Promise<void> {
		this.phase(phase);
		const started = this.elapsed();
		try {
			await operation();
		} catch {
			this.data.cleanupErrors.push(phase);
		} finally {
			const duration = this.elapsed() - started;
			if (phase === "session-dispose") this.data.sessionDisposeMs = duration;
			else this.data.mcpDisconnectMs = duration;
		}
	}
}
