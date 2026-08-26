import * as os from "node:os";
import type { Settings } from "../config/settings";

export interface CollabDisplayNameContext {
	settings: Pick<Settings, "get">;
}

/** Display name for this process's user in collab sessions. */
export function collabDisplayName(ctx: CollabDisplayNameContext): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}
