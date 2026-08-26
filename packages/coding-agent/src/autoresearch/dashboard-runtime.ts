import type { DashboardController } from "./types";

/** Headless dashboard controller; experiment state and tools remain fully active. */
export function createDashboardController(): DashboardController {
	return {
		clear: () => {},
		requestRender: () => {},
		updateWidget: () => {},
		showOverlay: async () => {},
	};
}
