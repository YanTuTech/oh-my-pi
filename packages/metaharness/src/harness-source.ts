import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

/** An input assertion, never execution evidence supplied by a caller. */
export interface HarnessSourceRequest {
	root: string;
	expectedSourceDigest?: string;
	expectedBaseCommit?: string;
}

export interface ContentFile {
	path: string;
	sha256: string;
}

export interface HarnessExecution {
	version: 1;
	baseCommit: string;
	sourceDigest: string;
	dependencyLockDigest: string;
	driverDigest: string;
	runtimeDigest: string;
	bunVersion: string;
	platform: string;
	entrypoint: string;
	files: ContentFile[];
}

export interface PreparedHarness {
	runtimeDir: string;
	execution: HarnessExecution;
}

/** Validate persisted identity without treating a caller's arbitrary digest as evidence. */
export function parseHarnessExecution(value: unknown): HarnessExecution {
	if (typeof value !== "object" || value === null) throw new Error("Missing harness execution evidence");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(record.baseCommit))
		throw new Error("Invalid harness base identity");
	for (const key of ["sourceDigest", "dependencyLockDigest", "driverDigest", "runtimeDigest"]) {
		if (typeof record[key] !== "string" || !/^[a-f0-9]{64}$/.test(record[key]))
			throw new Error("Invalid harness digest evidence");
	}
	if (
		typeof record.bunVersion !== "string" ||
		typeof record.platform !== "string" ||
		record.entrypoint !== "agent-worker.js"
	)
		throw new Error("Invalid harness runtime identity");
	if (!Array.isArray(record.files) || record.files.length === 0) throw new Error("Missing executable manifest");
	const files: ContentFile[] = [];
	for (const file of record.files) {
		if (
			typeof file !== "object" ||
			file === null ||
			typeof file.path !== "string" ||
			path.isAbsolute(file.path) ||
			file.path.split(/[\\/]/).some((part: string) => part === "..") ||
			typeof file.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		)
			throw new Error("Invalid executable manifest");
		files.push({ path: file.path, sha256: file.sha256 });
	}
	if (
		new Set(files.map(file => file.path)).size !== files.length ||
		!files.some(file => file.path === record.entrypoint) ||
		contentDigest(files) !== record.runtimeDigest
	)
		throw new Error("Executable manifest digest mismatch");
	return {
		version: 1,
		baseCommit: record.baseCommit,
		sourceDigest: String(record.sourceDigest),
		dependencyLockDigest: String(record.dependencyLockDigest),
		driverDigest: String(record.driverDigest),
		runtimeDigest: String(record.runtimeDigest),
		bunVersion: record.bunVersion,
		platform: record.platform,
		entrypoint: record.entrypoint,
		files,
	};
}

export function sha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function contentDigest(files: readonly ContentFile[]): string {
	return sha256(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
}

function within(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Runtime source only: the candidate cannot replace the benchmark or its answers. */
function isRuntimeSource(file: string): boolean {
	if (["package.json", "bun.lock", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"].includes(file)) return true;
	if (!file.startsWith("packages/") || file.startsWith("packages/metaharness/")) return false;
	if (/(^|\/)(test|tests|fixtures|node_modules|dist|runs|\.git)(\/|$)/.test(file)) return false;
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
	if (/(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/.test(file)) throw new Error("Secret-like file in harness source");
	return true;
}

async function readRegular(root: string, relative: string): Promise<Uint8Array> {
	const absolute = path.resolve(root, relative);
	if (!within(root, absolute)) throw new Error("Harness source path escapes its root");
	const actual = await fs.realpath(absolute);
	if (!within(root, actual) || (await fs.lstat(absolute)).isSymbolicLink()) {
		throw new Error(`Harness source symlink is not supported: ${relative}`);
	}
	return new Uint8Array(await Bun.file(absolute).arrayBuffer());
}

async function inventory(root: string): Promise<ContentFile[]> {
	const commit = await git.head.sha(root);
	if (!commit) throw new Error("Harness source must be a Git checkout with a HEAD commit");
	const tracked = await git.ls.tree(root, commit);
	const untracked = await git.ls.untracked(root);
	if (untracked.some(file => file.startsWith('"'))) {
		throw new Error("Harness source has quoted untracked filenames; use ordinary source filenames");
	}
	const names = new Set([...tracked, ...untracked].filter(isRuntimeSource));
	// Runtime-generated browser/export assets may be ignored by Git but are
	// still compiler inputs. Include their actual bytes in source identity.
	const visit = async (relative: string): Promise<void> => {
		for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
			const name = path.posix.join(relative, entry.name);
			if (!isRuntimeSource(name)) continue;
			if (entry.isSymbolicLink()) throw new Error(`Runtime asset symlink is not supported: ${name}`);
			if (entry.isDirectory()) await visit(name);
			else if (entry.isFile()) names.add(name);
		}
	};
	for (const entry of await fs.readdir(path.join(root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "metaharness") continue;
		const src = `packages/${entry.name}/src`;
		try {
			await visit(src);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	// The native binary is an ignored build input, not present in ls-files.
	const nativeDir = "packages/natives/native";
	for (const entry of await fs.readdir(path.join(root, nativeDir))) {
		if (entry.endsWith(".node") && entry.includes(`${process.platform}-${process.arch}`))
			names.add(`${nativeDir}/${entry}`);
	}
	const files: ContentFile[] = [];
	for (const name of [...names].sort()) {
		try {
			files.push({ path: name, sha256: sha256(await readRegular(root, name)) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// A tracked deletion is reflected by its absence in the effective tree.
		}
	}
	return files;
}

async function fileTree(root: string, relative = ""): Promise<ContentFile[]> {
	const files: ContentFile[] = [];
	for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
		const name = path.posix.join(relative, entry.name);
		if (entry.isSymbolicLink()) throw new Error("Executable harness artifacts must not contain symlinks");
		if (entry.isDirectory()) files.push(...(await fileTree(root, name)));
		else if (entry.isFile()) files.push({ path: name, sha256: sha256(await readRegular(root, name)) });
	}
	return files;
}

/** Verify the executable bytes, not a label or the mutable source checkout. */
export async function verifyPreparedHarness(prepared: PreparedHarness): Promise<void> {
	const files = await fileTree(prepared.runtimeDir);
	if (contentDigest(files) !== prepared.execution.runtimeDigest)
		throw new Error("Harness executable changed after preparation");
}

/**
 * Freeze source, compile a trusted driver against that source, and copy the
 * native runtime. Only built artifacts execute. External JS dependencies are
 * bundled; unresolved externals fail closed. No candidate grader is imported.
 */
export async function prepareHarness(
	request: HarnessSourceRequest,
	jobDir: string,
	trustedPackageDir: string,
): Promise<PreparedHarness> {
	const root = await fs.realpath(request.root);
	const baseCommit = await git.head.sha(root);
	if (!baseCommit) throw new Error("Harness source has no HEAD commit");
	if (request.expectedBaseCommit && request.expectedBaseCommit !== baseCommit)
		throw new Error("Harness base commit mismatch");
	if (request.expectedSourceDigest && !/^[a-f0-9]{64}$/.test(request.expectedSourceDigest))
		throw new Error("Invalid expected source digest");
	const before = await inventory(root);
	const sourceDigest = contentDigest(before);
	if (request.expectedSourceDigest && request.expectedSourceDigest !== sourceDigest)
		throw new Error("Harness source digest mismatch");
	const lock = before.find(file => file.path === "bun.lock");
	if (!lock) throw new Error("Harness source is missing bun.lock");
	const trustedRoot = path.resolve(trustedPackageDir, "../..");
	if (sha256(await readRegular(trustedRoot, "bun.lock")) !== lock.sha256) {
		throw new Error(
			"Candidate dependency lock differs from the installed evaluator dependencies; install a matching evaluation environment first",
		);
	}

	const preparationDir = await fs.mkdtemp(path.join(jobDir, "harness-"));
	const sourceDir = path.join(preparationDir, "source");
	const runtimeDir = path.join(preparationDir, "runtime");
	await fs.mkdir(sourceDir);
	await fs.mkdir(runtimeDir);
	try {
		for (const file of before) {
			const bytes = await readRegular(root, file.path);
			if (sha256(bytes) !== file.sha256) throw new Error("Harness source changed while snapshotting");
			await Bun.write(path.join(sourceDir, file.path), bytes);
		}
		if ((await git.head.sha(root)) !== baseCommit || contentDigest(await inventory(root)) !== sourceDigest) {
			throw new Error("Harness source changed while snapshotting");
		}
		const driverFiles = [
			"agent-worker.ts",
			"agent-protocol.ts",
			"agent-diagnostics.ts",
			"agent-system.md",
			"agent-fixture-server.ts",
			"challenge-fixture-server.ts",
			"challenge-data.ts",
			"disabled-legacy.ts",
			"unavailable-policy.ts",
		];
		const driverInventory: ContentFile[] = [];
		for (const name of driverFiles) {
			const bytes = await readRegular(trustedPackageDir, `adapters/mcp/${name}`);
			driverInventory.push({ path: name, sha256: sha256(bytes) });
			await Bun.write(path.join(sourceDir, "driver", name), bytes);
		}
		// Fresh workspace links are essential: a root node_modules symlink would
		// silently resolve @oh-my-pi imports back to the live baseline checkout.
		const modules = path.join(sourceDir, "node_modules");
		await fs.mkdir(path.join(modules, "@oh-my-pi"), { recursive: true });
		for (const name of await fs.readdir(path.join(trustedRoot, "node_modules"))) {
			if (name === "@oh-my-pi" || name === ".bin") continue;
			await fs.symlink(path.join(trustedRoot, "node_modules", name), path.join(modules, name), "dir");
		}
		for (const directory of await fs.readdir(path.join(sourceDir, "packages"), { withFileTypes: true })) {
			if (!directory.isDirectory()) continue;
			const packageRoot = path.join(sourceDir, "packages", directory.name);
			const manifestFile = Bun.file(path.join(packageRoot, "package.json"));
			if (!(await manifestFile.exists())) continue;
			const manifest = await manifestFile.json();
			if (typeof manifest.name !== "string" || !/^@oh-my-pi\/[a-z0-9-]+$/.test(manifest.name)) continue;
			await fs.symlink(packageRoot, path.join(modules, manifest.name), "dir");
		}
		const built = await Bun.build({
			entrypoints: ["agent-worker.ts", "agent-fixture-server.ts", "challenge-fixture-server.ts"].map(name =>
				path.join(sourceDir, "driver", name),
			),
			outdir: runtimeDir,
			target: "bun",
			metafile: true,
			external: ["@oh-my-pi/pi-natives", "@oh-my-pi/pi-natives/*"],
			plugins: [
				{
					name: "candidate-workspace",
					setup(build) {
						build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
							path: path.join(sourceDir, "driver/disabled-legacy.ts"),
						}));
						build.onResolve({ filter: /^\.\/omp-policy-(limits|digest)\.generated$/ }, () => ({
							path: path.join(sourceDir, "driver/unavailable-policy.ts"),
						}));
						build.onResolve({ filter: /^@oh-my-pi\// }, args => {
							if (args.path === "@oh-my-pi/pi-natives" || args.path.startsWith("@oh-my-pi/pi-natives/"))
								return { path: args.path, external: true };
							const resolved = Bun.resolveSync(args.path, sourceDir);
							if (!within(sourceDir, resolved)) throw new Error("Workspace import escaped the frozen candidate");
							return { path: resolved };
						});
					},
				},
			],
		});
		if (!built.success)
			throw new Error(
				`Harness compilation failed: ${built.logs
					.map(log => log.message)
					.join("; ")
					.slice(0, 2000)}`,
			);
		if (!built.metafile) throw new Error("Harness compiler did not produce dependency evidence");
		const builtin = new Set(builtinModules);
		// Validate what remains in executable output, not tree-shaken input
		// imports (Bun marks some eliminated input edges as external).
		for (const output of Object.values(built.metafile.outputs)) {
			for (const dependency of output.imports) {
				const name = dependency.path;
				if (
					name.startsWith("node:") ||
					name === "bun" ||
					name.startsWith("bun:") ||
					builtin.has(name) ||
					name === "@oh-my-pi/pi-natives" ||
					name.startsWith("@oh-my-pi/pi-natives/")
				)
					continue;
				const emitted = path.resolve(runtimeDir, name);
				if (within(runtimeDir, emitted) && (await Bun.file(emitted).exists())) continue;
				throw new Error(`Unfrozen runtime dependency: ${name}`);
			}
		}
		const nativeRoot = path.join(sourceDir, "packages/natives");
		await fs.cp(nativeRoot, path.join(runtimeDir, "node_modules/@oh-my-pi/pi-natives"), { recursive: true });
		const files = await fileTree(runtimeDir);
		const execution: HarnessExecution = {
			version: 1,
			baseCommit,
			sourceDigest,
			dependencyLockDigest: lock.sha256,
			driverDigest: contentDigest(driverInventory),
			runtimeDigest: contentDigest(files),
			bunVersion: Bun.version,
			platform: `${process.platform}-${process.arch}`,
			entrypoint: "agent-worker.js",
			files,
		};
		await Bun.write(path.join(preparationDir, "execution.json"), JSON.stringify(execution, null, 2));
		await Bun.write(path.join(preparationDir, "source-manifest.json"), JSON.stringify(before, null, 2));
		await Bun.write(path.join(preparationDir, "build-inputs.json"), JSON.stringify(built.metafile, null, 2));
		// Compiled code and native bytes are sufficient; discard source, resolver
		// links and any accidental access back into the producer's checkout.
		await fs.rm(sourceDir, { recursive: true, force: true });
		return { runtimeDir, execution };
	} catch (error) {
		await fs.rm(preparationDir, { recursive: true, force: true });
		throw error;
	}
}
