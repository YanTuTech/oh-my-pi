import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagerServer } from "../../src/server";

// A separate process keeps fixture credentials out of the test runner's global
// environment while exercising the real REST -> CLI -> agent launch path.
if (process.env.METAHARNESS_TEST_HOST !== "1") throw new Error("Test host requires explicit fixture environment");
const root = process.argv[2];
if (!root) throw new Error("Missing test job root");
const manager = new ManagerServer(root);
const server = manager.start(0);
await Bun.write(path.join(root, "ready.tmp"), JSON.stringify({ port: server.port }));
await fs.rename(path.join(root, "ready.tmp"), path.join(root, "ready.json"));
process.on("SIGTERM", () => {
	void manager.stop().finally(() => process.exit(0));
});
