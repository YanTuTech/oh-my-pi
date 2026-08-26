import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { SETTINGS_SCHEMA } from "../packages/coding-agent/src/config/settings-schema";
import boundary from "../runtime-boundary.json" with { type: "json" };

interface PackageManifest {
	bin?: unknown;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

function normalizeRepoPath(value: string): string {
	const normalized = value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
	if (normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value)) {
		fail(`Boundary path must be repository-relative: ${value}`);
	}
	return normalized;
}

function assertUnique(label: string, values: readonly string[]): void {
	const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
	if (duplicates.length > 0) fail(`${label} contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
}

function assertExports(
	label: string,
	actual: ReadonlySet<string>,
	required: readonly string[],
	forbidden: readonly string[],
): void {
	for (const symbol of required) {
		if (!actual.has(symbol)) fail(`${label} is missing required export: ${symbol}`);
	}
	for (const symbol of forbidden) {
		if (actual.has(symbol)) fail(`${label} exposes forbidden export: ${symbol}`);
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(relativePath: string): Promise<boolean> {
	try {
		await fs.lstat(path.join(repoRoot, relativePath));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const uniqueListFields: Array<[string, readonly string[]]> = [
	["requiredWorkspacePaths", boundary.requiredWorkspacePaths],
	["forbiddenWorkspacePaths", boundary.forbiddenWorkspacePaths],
	["requiredBuildEntrypoints", boundary.requiredBuildEntrypoints],
	["requiredRootSymbols", boundary.requiredRootSymbols],
	["requiredEmbeddedRuntimeSymbols", boundary.requiredEmbeddedRuntimeSymbols],
	["forbiddenEmbeddedRuntimeSymbols", boundary.forbiddenEmbeddedRuntimeSymbols],
	["requiredHtmlExportSymbols", boundary.requiredHtmlExportSymbols],
	["blockedPackageExports", boundary.blockedPackageExports],
	["forbiddenPublicSymbols", boundary.forbiddenPublicSymbols],
	["forbiddenModelResolverSymbols", boundary.forbiddenModelResolverSymbols],
	["forbiddenNativeExportSymbols", boundary.forbiddenNativeExportSymbols],
	["forbiddenSettingPaths", boundary.forbiddenSettingPaths],
	["forbiddenRuntimeDependencies", boundary.forbiddenRuntimeDependencies],
	["forbiddenBuildInputFragments", boundary.forbiddenBuildInputFragments],
];

for (const [label, values] of uniqueListFields) assertUnique(label, values);
for (const value of [
	...boundary.requiredWorkspacePaths,
	...boundary.forbiddenWorkspacePaths,
	...boundary.requiredBuildEntrypoints,
	...boundary.retainedExceptions.map(entry => entry.path),
])
	normalizeRepoPath(value);

assertUnique(
	"requiredPackageExports",
	boundary.requiredPackageExports.map(entry => entry.subpath),
);
assertUnique(
	"retainedExceptions",
	boundary.retainedExceptions.map(entry => entry.path),
);

for (const requiredPath of boundary.requiredWorkspacePaths) {
	if (!(await pathExists(requiredPath))) fail(`Required Runtime path is missing: ${requiredPath}`);
}

for (const forbiddenPath of boundary.forbiddenWorkspacePaths) {
	if (await pathExists(forbiddenPath)) fail(`Forbidden terminal product path exists: ${forbiddenPath}`);
}

for (const exception of boundary.retainedExceptions) {
	normalizeRepoPath(exception.path);
	if (exception.reason.trim().length < 20) fail(`Retained exception needs a concrete reason: ${exception.path}`);
	if (!(await pathExists(exception.path))) fail(`Documented retained exception is missing: ${exception.path}`);
}

for (const settingPath of boundary.forbiddenSettingPaths) {
	if (Object.hasOwn(SETTINGS_SCHEMA, settingPath)) fail(`Forbidden UI setting is registered: ${settingPath}`);
}

const nativeDeclarations = await Bun.file(path.join(repoRoot, "packages/natives/native/index.d.ts")).text();
for (const symbol of boundary.forbiddenNativeExportSymbols) {
	if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(nativeDeclarations)) {
		fail(`Forbidden native UI export is declared: ${symbol}`);
	}
}

const packagePath = path.join(repoRoot, boundary.runtimePackage, "package.json");
const packageManifest = (await Bun.file(packagePath).json()) as PackageManifest;
const packageExports = packageManifest.exports ?? {};

if (Object.hasOwn(packageManifest, "bin")) fail("Runtime package must not declare a bin entry");

for (const entry of boundary.requiredPackageExports) {
	const target = packageExports[entry.subpath];
	if (!isRecord(target) || target.types !== entry.source || target.import !== entry.source) {
		fail(`Required package export ${entry.subpath} must resolve types and import to ${entry.source}`);
	}
}

for (const subpath of boundary.blockedPackageExports) {
	if (packageExports[subpath] !== null) fail(`Terminal package export must remain blocked with null: ${subpath}`);
}

const runtimeDependencySections = [
	packageManifest.dependencies,
	packageManifest.optionalDependencies,
	packageManifest.peerDependencies,
];
const runtimeDependencies = new Set(runtimeDependencySections.flatMap(section => Object.keys(section ?? {})));
for (const dependency of boundary.forbiddenRuntimeDependencies) {
	if (runtimeDependencies.has(dependency)) fail(`Forbidden Runtime dependency is declared: ${dependency}`);
}

const buildEntrypoints = boundary.requiredBuildEntrypoints.map(entrypoint => path.join(repoRoot, entrypoint));
let buildInputCount = 0;
const build = await Bun.build({
	entrypoints: buildEntrypoints,
	target: "bun",
	external: ["omp-legacy-pi-modules"],
	define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
	naming: "[dir]/[name]-[hash].[ext]",
	metafile: true,
});

if (!build.success) {
	for (const log of build.logs) fail(`Runtime boundary build failed: ${log.message}`);
}

if (!build.metafile) {
	fail("Runtime boundary build did not produce a dependency metafile");
} else {
	const exportsByEntrypoint = new Map<string, ReadonlySet<string>>();
	for (const output of Object.values(build.metafile.outputs)) {
		if (!output.entryPoint) continue;
		exportsByEntrypoint.set(normalizeRepoPath(output.entryPoint), new Set(output.exports));
	}
	const rootExports = exportsByEntrypoint.get("packages/coding-agent/src/index.ts") ?? new Set<string>();
	const embeddedRuntimeExports =
		exportsByEntrypoint.get("packages/coding-agent/src/runtime-api.ts") ?? new Set<string>();
	const htmlExports = exportsByEntrypoint.get("packages/coding-agent/src/export/html/index.ts") ?? new Set<string>();
	assertExports("Runtime package root", rootExports, boundary.requiredRootSymbols, boundary.forbiddenPublicSymbols);
	assertExports(
		"Embedded Runtime API",
		embeddedRuntimeExports,
		boundary.requiredEmbeddedRuntimeSymbols,
		boundary.forbiddenEmbeddedRuntimeSymbols,
	);
	assertExports("HTML export API", htmlExports, boundary.requiredHtmlExportSymbols, []);

	const buildInputs = Object.keys(build.metafile.inputs).map(input => {
		const absolute = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
		return path.relative(repoRoot, absolute).split(path.sep).join("/");
	});
	buildInputCount = buildInputs.length;

	for (const entrypoint of boundary.requiredBuildEntrypoints) {
		if (!buildInputs.includes(entrypoint))
			fail(`Runtime build graph is missing its declared entrypoint: ${entrypoint}`);
	}

	for (const input of buildInputs) {
		for (const fragment of boundary.forbiddenBuildInputFragments) {
			if (input.includes(fragment)) fail(`Runtime build graph includes forbidden input ${input} via ${fragment}`);
		}
	}
}

const modelResolverBuild = await Bun.build({
	entrypoints: [path.join(repoRoot, "packages/coding-agent/src/config/model-resolver.ts")],
	target: "bun",
	external: ["omp-legacy-pi-modules"],
	metafile: true,
});
if (!modelResolverBuild.success || !modelResolverBuild.metafile) {
	for (const log of modelResolverBuild.logs) fail(`Model resolver contract build failed: ${log.message}`);
} else {
	const output = Object.values(modelResolverBuild.metafile.outputs).find(entry => entry.entryPoint !== undefined);
	const modelResolverExports = new Set(output?.exports ?? []);
	assertExports("Model resolver compatibility API", modelResolverExports, [], boundary.forbiddenModelResolverSymbols);
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`runtime-boundary: ${failure}\n`);
	process.exit(1);
}

process.stdout.write(
	`Runtime boundary v${boundary.version} passed: ${boundary.requiredWorkspacePaths.length} required paths, ${boundary.forbiddenWorkspacePaths.length} forbidden paths, ${boundary.forbiddenSettingPaths.length} retired UI settings, ${boundary.forbiddenNativeExportSymbols.length} retired native UI exports, ${buildInputCount} verified build inputs, ${boundary.retainedExceptions.length} documented exceptions.\n`,
);
