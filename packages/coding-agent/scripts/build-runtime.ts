import * as fs from "node:fs/promises";
import * as path from "node:path";
import boundary from "../../../runtime-boundary.json" with { type: "json" };

const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const outdir = path.join(packageDir, "dist", "runtime");

await fs.rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: boundary.requiredBuildEntrypoints.map(entrypoint => path.join(repoRoot, entrypoint)),
	root: path.join(packageDir, "src"),
	outdir,
	target: "bun",
	external: ["@oh-my-pi/pi-natives", "@oh-my-pi/pi-natives/*", "omp-legacy-pi-modules"],
	define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
	naming: "[dir]/[name].js",
});

if (!result.success) {
	for (const log of result.logs) process.stderr.write(`${log.message}\n`);
	process.exitCode = 1;
}
