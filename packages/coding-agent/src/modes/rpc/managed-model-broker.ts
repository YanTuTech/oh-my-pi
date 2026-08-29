import * as path from "node:path";
import { type StreamFn, streamProxy } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";

const MANAGED_MODEL_BROKER_URL = "http://rb-model-broker.invalid";
const MANAGED_MODEL_BROKER_AUTHORITY = "unix-peer-v1";

export function validateManagedModelBrokerSocket(socketPath: string): void {
	if (!path.isAbsolute(socketPath)) {
		throw new Error("Managed Runtime requires an absolute model broker socket path");
	}
}

/**
 * Reuse the agent-core proxy stream over a Unix-domain socket. The synthetic
 * URL is never resolved on a network interface; Bun routes every request to
 * the launcher-selected socket supplied in `unix`. This transport choice does
 * not authenticate the broker peer; product reachability remains gated on a
 * LaunchGuard-owned connected FD or equivalent peer code-identity proof.
 */
export function createManagedModelBrokerStreamFn(socketPath: string): StreamFn {
	validateManagedModelBrokerSocket(socketPath);
	const fetchOverUnix: FetchImpl = (input, init) => fetch(input, { ...init, unix: socketPath });
	return (model, context, options) =>
		streamProxy(model, context, {
			...options,
			authToken: MANAGED_MODEL_BROKER_AUTHORITY,
			proxyUrl: MANAGED_MODEL_BROKER_URL,
			fetch: fetchOverUnix,
		});
}
