import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const outdir = path.join(packageDir, "dist", "runtime");

await fs.rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [
		path.join(packageDir, "src", "index.ts"),
		path.join(packageDir, "src", "runtime-api.ts"),
		path.join(packageDir, "src", "runtime-acp-host.ts"),
		path.join(packageDir, "src", "runtime-rpc-host.ts"),
	],
	outdir,
	target: "bun",
	external: ["omp-legacy-pi-modules"],
	define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
	naming: "[name].js",
});

if (!result.success) {
	for (const log of result.logs) process.stderr.write(`${log.message}\n`);
	process.exitCode = 1;
}
