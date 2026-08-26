/** Headless ACP process entrypoint for Agent Runtime embeddings. */

import { ModelRegistry } from "./config/model-registry";
import { Settings } from "./config/settings";
import { createAcpSessionFactory, runAcpMode } from "./modes/acp";
import { discoverAuthStorage } from "./sdk";

export async function runRuntimeAcpHost(): Promise<void> {
	const cwd = process.cwd();
	const settings = await Settings.loadIsolated({ cwd });
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	try {
		await runAcpMode(
			createAcpSessionFactory({
				settings,
				authStorage,
				modelRegistry,
			}),
		);
	} finally {
		authStorage.close();
	}
}

if (import.meta.main) {
	runRuntimeAcpHost().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
