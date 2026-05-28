import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DIST_DIR = "dist";
const RELEASE_DIR = join(DIST_DIR, "release");
const BINARY_NAME = "tw-portal";
const GITHUB_REMOTE = "origin";
const TAR_BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_SIZE = 100;
const TAR_MODE_OFFSET = 100;
const TAR_MODE_SIZE = 8;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_SIZE = 8;

type PackageMetadata = {
	name?: unknown;
	version?: unknown;
};

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

type ArtifactSpec = {
	platform: string;
	binaryName: string;
	assetName: string;
	label: string;
	format: "tar.gz" | "zip";
};

const ARTIFACTS = [
	{
		platform: "darwin-arm64",
		binaryName: BINARY_NAME,
		assetName: "tw-portal-darwin-arm64.tar.gz",
		label: "macOS arm64 tarball",
		format: "tar.gz",
	},
	{
		platform: "darwin-x64",
		binaryName: BINARY_NAME,
		assetName: "tw-portal-darwin-x64.tar.gz",
		label: "macOS x64 tarball",
		format: "tar.gz",
	},
	{
		platform: "linux-arm64",
		binaryName: BINARY_NAME,
		assetName: "tw-portal-linux-arm64.tar.gz",
		label: "Linux arm64 tarball",
		format: "tar.gz",
	},
	{
		platform: "linux-x64",
		binaryName: BINARY_NAME,
		assetName: "tw-portal-linux-x64.tar.gz",
		label: "Linux x64 tarball",
		format: "tar.gz",
	},
	{
		platform: "windows-x64",
		binaryName: `${BINARY_NAME}.exe`,
		assetName: "tw-portal-windows-x64.zip",
		label: "Windows x64 zip",
		format: "zip",
	},
] as const satisfies readonly ArtifactSpec[];

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

async function main() {
	const { name, version } = await readPackageMetadata();
	const packageName = readRequiredString(name, "package.json name");
	const tag = `v${readRequiredString(version, "package.json version")}`;

	console.log(`Preparing ${packageName} ${tag}`);

	await ensureReleaseDoesNotExist(tag);
	await ensureTagDoesNotExist(tag);
	await ensureCleanWorktree();

	await run(["bun", "run", "build"]);
	const assets = await createArtifacts();

	await run(["git", "tag", "-a", tag, "-m", `${packageName} ${tag}`]);
	await run(["git", "push", GITHUB_REMOTE, tag]);
	await run([
		"gh",
		"release",
		"create",
		tag,
		...assets.map((asset) => `${asset.path}#${asset.label}`),
		"--verify-tag",
		"--title",
		`${packageName} ${tag}`,
		"--generate-notes",
	]);

	console.log(`Published ${tag}`);
}

async function readPackageMetadata() {
	return (await Bun.file(
		new URL("./package.json", import.meta.url),
	).json()) as PackageMetadata;
}

function readRequiredString(value: unknown, field: string) {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`${field} must be a non-empty string`);
}

async function ensureReleaseDoesNotExist(tag: string) {
	const result = await capture(
		["gh", "release", "view", tag, "--json", "url", "--jq", ".url"],
		{ allowFailure: true },
	);

	if (result.exitCode === 0) {
		throw new Error(`Release ${tag} already exists: ${result.stdout.trim()}`);
	}

	if (!/release not found/i.test(`${result.stdout}\n${result.stderr}`)) {
		throw new Error(
			commandFailureMessage(["gh", "release", "view", tag], result),
		);
	}
}

async function ensureTagDoesNotExist(tag: string) {
	const localTag = await capture(
		["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
		{ allowFailure: true },
	);
	if (localTag.exitCode === 0)
		throw new Error(`Local tag ${tag} already exists`);
	if (localTag.exitCode !== 1) {
		throw new Error(commandFailureMessage(["git", "rev-parse", tag], localTag));
	}

	const remoteTag = await capture(
		[
			"git",
			"ls-remote",
			"--exit-code",
			"--tags",
			GITHUB_REMOTE,
			`refs/tags/${tag}`,
		],
		{ allowFailure: true },
	);
	if (remoteTag.exitCode === 0)
		throw new Error(`Remote tag ${tag} already exists`);
	if (remoteTag.exitCode !== 2) {
		throw new Error(
			commandFailureMessage(
				["git", "ls-remote", GITHUB_REMOTE, tag],
				remoteTag,
			),
		);
	}
}

async function ensureCleanWorktree() {
	const status = await capture(["git", "status", "--porcelain=v1"]);
	if (status.stdout.trim()) {
		throw new Error(
			`Worktree must be clean before deploying:\n${status.stdout.trim()}`,
		);
	}
}

async function createArtifacts() {
	await rm(RELEASE_DIR, { recursive: true, force: true });
	await mkdir(RELEASE_DIR, { recursive: true });

	const assets: { path: string; label: string }[] = [];

	for (const artifact of ARTIFACTS) {
		const platformDir = join(DIST_DIR, artifact.platform);
		const binaryPath = join(platformDir, artifact.binaryName);
		const assetPath = join(RELEASE_DIR, artifact.assetName);

		const binaryStat = await ensureFile(binaryPath);

		if (artifact.format === "tar.gz") {
			await createTarGzip(
				assetPath,
				artifact.binaryName,
				binaryPath,
				binaryStat.mode,
			);
		} else {
			await run(["zip", "-q", "-X", "-j", assetPath, binaryPath]);
		}

		const { size } = await stat(assetPath);
		console.log(`Created ${assetPath} (${Math.round(size / 1024 / 1024)} MB)`);
		assets.push({ path: assetPath, label: artifact.label });
	}

	return assets;
}

async function ensureFile(path: string) {
	const fileStat = await stat(path).catch(() => undefined);
	if (!fileStat?.isFile())
		throw new Error(`Expected build output missing: ${path}`);
	return fileStat;
}

async function createTarGzip(
	assetPath: string,
	entryName: string,
	sourcePath: string,
	sourceMode: number,
) {
	const archive = new Bun.Archive({ [entryName]: Bun.file(sourcePath) });
	const tarBytes = await archive.bytes();
	// Bun.Archive object entries do not preserve executable bits, so keep the
	// built binary mode in the tar header before gzipping the archive.
	applyTarMode(tarBytes, entryName, sourceMode & 0o777);
	await Bun.write(assetPath, Bun.gzipSync(tarBytes));
}

function applyTarMode(
	tarBytes: Uint8Array<ArrayBuffer>,
	entryName: string,
	mode: number,
) {
	const header = tarBytes.subarray(0, TAR_BLOCK_SIZE);
	const actualEntryName = readTarHeaderString(
		header,
		TAR_NAME_OFFSET,
		TAR_NAME_SIZE,
	);
	if (actualEntryName !== entryName) {
		throw new Error(
			`Bun.Archive wrote unexpected tar entry ${actualEntryName}; expected ${entryName}`,
		);
	}

	header.fill(
		0x20,
		TAR_CHECKSUM_OFFSET,
		TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_SIZE,
	);
	writeTarHeaderString(
		header,
		TAR_MODE_OFFSET,
		TAR_MODE_SIZE,
		mode.toString(8).padStart(7, "0"),
	);

	let checksum = 0;
	for (const byte of header) checksum += byte;

	writeTarHeaderString(
		header,
		TAR_CHECKSUM_OFFSET,
		TAR_CHECKSUM_SIZE,
		checksum.toString(8).padStart(6, "0"),
	);
	header[TAR_CHECKSUM_OFFSET + 6] = 0;
	header[TAR_CHECKSUM_OFFSET + 7] = 0x20;
}

function readTarHeaderString(
	header: Uint8Array<ArrayBuffer>,
	offset: number,
	size: number,
) {
	let end = offset;
	const limit = offset + size;
	while (end < limit && header[end] !== 0) end += 1;
	return new TextDecoder().decode(header.subarray(offset, end));
}

function writeTarHeaderString(
	header: Uint8Array<ArrayBuffer>,
	offset: number,
	size: number,
	value: string,
) {
	if (value.length >= size)
		throw new Error(`Tar header value is too long: ${value}`);
	for (let index = 0; index < value.length; index += 1) {
		header[offset + index] = value.charCodeAt(index);
	}
	header[offset + value.length] = 0;
}

async function run(command: string[]) {
	const child = Bun.spawn(command, {
		cwd: import.meta.dir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;

	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

async function capture(
	command: string[],
	options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
	const child = Bun.spawn(command, {
		cwd: import.meta.dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const result = { exitCode, stdout, stderr };

	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(commandFailureMessage(command, result));
	}

	return result;
}

function commandFailureMessage(
	command: readonly string[],
	result: CommandResult,
) {
	const stderr = result.stderr.trim();
	return [
		`Command failed (${result.exitCode}): ${command.join(" ")}`,
		stderr ? stderr : undefined,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}
