import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const ENTRYPOINT = "./index.ts";
const DIST_DIR = "dist";
const BINARY_NAME = "tw-portal";

type PackageMetadata = {
	version?: unknown;
};

type BuildSpec = {
	platform: string;
	target: Bun.Build.CompileTarget;
};

const BUILDS = [
	{ platform: "darwin-arm64", target: "bun-darwin-arm64" },
	{ platform: "darwin-x64", target: "bun-darwin-x64" },
	{ platform: "linux-arm64", target: "bun-linux-arm64" },
	{ platform: "linux-x64", target: "bun-linux-x64" },
	{ platform: "windows-x64", target: "bun-windows-x64" },
] as const satisfies readonly BuildSpec[];

const BUILD_METADATA = {
	version: await readPackageVersion(),
	buildDate: new Date().toISOString(),
	gitCommit: await readGitCommit(),
};

await Promise.all(
	BUILDS.map((build) =>
		rm(join(DIST_DIR, build.platform), { recursive: true, force: true }),
	),
);

for (const build of BUILDS) {
	const outfile = join(DIST_DIR, build.platform, binaryNameFor(build.target));

	await mkdir(dirname(outfile), { recursive: true });

	console.log(`Building ${build.platform} (${build.target}) -> ${outfile}`);

	const result = await Bun.build({
		entrypoints: [ENTRYPOINT],
		target: "bun",
		format: "esm",
		minify: true,
		bytecode: true,
		sourcemap: "none",
		env: "disable",
		define: {
			"process.env.NODE_ENV": JSON.stringify("production"),
			TW_PORTAL_VERSION: JSON.stringify(BUILD_METADATA.version),
			TW_PORTAL_BUILD_DATE: JSON.stringify(BUILD_METADATA.buildDate),
			TW_PORTAL_GIT_COMMIT: JSON.stringify(BUILD_METADATA.gitCommit),
		},
		compile: {
			target: build.target,
			outfile,
		},
	});

	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exitCode = 1;
		continue;
	}

	const { size } = await stat(outfile);
	console.log(`Built ${outfile} (${formatBytes(size)})`);
}

if (process.exitCode) {
	process.exit();
}

await mkdir(DIST_DIR, { recursive: true });

function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB"] as const;
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function readPackageVersion() {
	const packageJson = (await Bun.file(
		new URL("./package.json", import.meta.url),
	).json()) as PackageMetadata;
	if (typeof packageJson.version === "string" && packageJson.version.trim()) {
		return packageJson.version.trim();
	}

	return "unknown";
}

async function readGitCommit() {
	try {
		const git = Bun.spawn(["git", "rev-parse", "--short=12", "HEAD"], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = await new Response(git.stdout).text();
		const exitCode = await git.exited;
		if (exitCode === 0 && output.trim()) return output.trim();
	} catch {
		// Fall through to the printable unknown value below.
	}

	return "unknown";
}

function binaryNameFor(target: Bun.Build.CompileTarget) {
	return target.startsWith("bun-windows-") ? `${BINARY_NAME}.exe` : BINARY_NAME;
}
