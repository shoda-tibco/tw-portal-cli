#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

declare const TW_PORTAL_VERSION: string | undefined;
declare const TW_PORTAL_BUILD_DATE: string | undefined;
declare const TW_PORTAL_GIT_COMMIT: string | undefined;

const BASE_URL = "https://ng1.angus.mrisoftware.com";
const LOGIN_URL = `${BASE_URL}/tenant/TranswesternMidwest/TranswesternMidwest/default.aspx`;
const API_URL = `${BASE_URL}/contactapi/v1/reservationresources/aggregate`;
const RESERVATION_API_URL = `${BASE_URL}/contactapi/v1/reservations`;
const RESOURCE_DETAILS_API_URL = `${BASE_URL}/contactapi/v1/reservationResources/details`;
const RESERVATION_PAGE_URL = `${BASE_URL}/Tenant/TranswesternMidwest/TranswesternMidwest/RR/ResourceReservations.aspx`;
const TIME_ZONE = "America/Chicago";
const CONFIG_DIR = `${homedir()}/.tw-portal`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const SESSION_CACHE_PATH = `${CONFIG_DIR}/session.json`;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESERVATION_BUFFER_MINUTES = 30;
const DEFAULT_SCHEDULE_DAYS = 14;
const DEFAULT_SCHEDULE_MIN_TIME_MINUTES = 8 * 60;
const RESOURCES = [
	{ id: "900000013", name: "CAR #1" },
	{ id: "1200001136", name: "CAR #2" },
] as const;
const RESERVATION_QUESTION_CONFIG = [
	{
		id: 900000026,
		configKey: "name",
		textPattern: /first name.*last name/i,
	},
	{
		id: 900000027,
		configKey: "company",
		textPattern: /company name/i,
	},
	{
		id: 900000028,
		configKey: "license_plate",
		textPattern: /license plate/i,
	},
	{
		id: 900000029,
		configKey: "make_model",
		textPattern: /vehicle details|type.*color/i,
	},
	{
		id: 900000030,
		configKey: "phone",
		textPattern: /emergency phone/i,
	},
] as const;

type CommandOptions =
	| ConfigOptions
	| ScheduleOptions
	| ReserveOptions
	| VersionOptions;

type ConfigOptions = {
	command: "config";
};

type VersionOptions = {
	command: "version";
};

type ScheduleOptions = {
	command: "schedule";
	days: number;
	from: Date;
	durationMinutes: number;
	minTimeMinutes: number;
	json: boolean;
	showAuth: boolean;
};

type ReserveOptions = {
	command: "reserve";
	start: Date;
	durationMinutes: number;
	json: boolean;
	showAuth: boolean;
	dryRun: boolean;
};

type StoredCookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
};

type SessionCache = {
	savedAt: string;
	cookies: StoredCookie[];
};

type Booking = {
	ResourceId: number;
	ResourceName: string;
	StartDate: string;
	EndDate: string;
};

type TimeBlock = {
	StartDate: string;
	EndDate: string;
};

type ReservationQuestion = {
	Id: number;
	QuestionText: string;
	Options: string;
	QuestionType: string;
	AnswerText?: string;
};

type ReservationResourceDetails = {
	Id: number;
	Name: string;
	Questions?: ReservationQuestion[];
	Amenities?: unknown[];
	RequireEntireTimeBlock?: boolean;
};

type ReservationPayload = {
	resourceIds: number[];
	requestedForContactId: number;
	dateRequired: string;
	durationMinutes: number;
	answers: ReservationQuestion[];
	amenities: unknown[];
	TnCAccepted: true;
	displayPreference: "None";
	resourceAvailabilityIds: unknown[];
	recurrencePattern: unknown[];
};

type ReservationCreateResponse = {
	Success?: boolean;
	EntityID?: number;
	Message?: string;
	Messages?: string[];
	Errors?: unknown;
	ModelState?: unknown;
};

type ScheduleResponse = {
	Bookings?: Booking[];
	Unavailable?: TimeBlock[];
	FirstComeFirstServed?: TimeBlock[];
	AvailableTimeBlocks?: TimeBlock[];
};

type Interval = {
	resourceId?: number;
	resourceName?: string;
	kind: "booking" | "unavailable" | "firstCome" | "available";
	start: Date;
	end: Date;
};

type HtmlAttributes = Record<string, string> & {
	name?: string;
	value?: string;
};

type PortalConfig = {
	username: string;
	password: string;
	name: string;
	company: string;
	license_plate: string;
	make_model: string;
	phone: string;
};

type ConfigPrompt = {
	key: keyof PortalConfig;
	label: string;
};

type ConfigPromptSection = {
	heading: string;
	prompts: readonly ConfigPrompt[];
};

type PackageMetadata = {
	version?: unknown;
};

type VersionResult = {
	version: string;
	buildDate: string;
	gitCommit: string;
};

const CONFIG_CREDENTIAL_PROMPTS = [
	{ key: "username", label: "Username" },
	{ key: "password", label: "Password" },
] as const satisfies readonly ConfigPrompt[];
const CONFIG_VEHICLE_PROMPTS = [
	{ key: "name", label: "Name" },
	{ key: "company", label: "Company" },
	{ key: "phone", label: "Phone number" },
	{ key: "make_model", label: "Vehicle make, model, and color" },
	{ key: "license_plate", label: "License plate" },
] as const satisfies readonly ConfigPrompt[];
const CONFIG_PROMPT_SECTIONS = [
	{
		heading: "Enter credentials for the Transwestern Service Portal",
		prompts: CONFIG_CREDENTIAL_PROMPTS,
	},
	{
		heading: "Enter vehicle details",
		prompts: CONFIG_VEHICLE_PROMPTS,
	},
] as const satisfies readonly ConfigPromptSection[];
const CONFIG_PROMPTS: readonly ConfigPrompt[] = [
	...CONFIG_CREDENTIAL_PROMPTS,
	...CONFIG_VEHICLE_PROMPTS,
];

class CookieJar {
	private cookies = new Map<
		string,
		{ value: string; domain: string; path: string; secure: boolean }
	>();

	static from(cookies: StoredCookie[]) {
		const jar = new CookieJar();
		for (const cookie of cookies) {
			jar.cookies.set(cookie.name, {
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path,
				secure: cookie.secure,
			});
		}
		return jar;
	}

	store(headers: Headers, responseUrl: string) {
		const url = new URL(responseUrl);
		for (const header of getSetCookieHeaders(headers)) {
			const [nameValue, ...attributes] = header.split(";");
			if (!nameValue) continue;

			const separator = nameValue.indexOf("=");
			if (separator === -1) continue;

			const name = nameValue.slice(0, separator).trim();
			const value = nameValue.slice(separator + 1).trim();
			if (!name) continue;

			let domain = url.hostname;
			let path = "/";
			let secure = url.protocol === "https:";

			for (const rawAttribute of attributes) {
				const attribute = rawAttribute.trim();
				const [rawKey, ...rawValue] = attribute.split("=");
				if (!rawKey) continue;

				const key = rawKey.toLowerCase();
				const attrValue = rawValue.join("=");

				if (key === "domain" && attrValue)
					domain = attrValue.replace(/^\./, "").toLowerCase();
				if (key === "path" && attrValue) path = attrValue;
				if (key === "secure") secure = true;
			}

			if (
				value === "" &&
				attributes.some((attribute) =>
					attribute.trim().toLowerCase().startsWith("expires="),
				)
			) {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, { value, domain, path, secure });
			}
		}
	}

	header(requestUrl: string) {
		const url = new URL(requestUrl);
		const matchingCookies = [];

		for (const [name, cookie] of this.cookies) {
			const domainMatches =
				url.hostname === cookie.domain ||
				url.hostname.endsWith(`.${cookie.domain}`);
			const pathMatches = url.pathname.startsWith(cookie.path);
			const secureMatches = !cookie.secure || url.protocol === "https:";

			if (domainMatches && pathMatches && secureMatches) {
				matchingCookies.push(`${name}=${cookie.value}`);
			}
		}

		return matchingCookies.join("; ");
	}

	get(name: string) {
		const exact = this.cookies.get(name);
		if (exact) return exact.value;

		const lowerName = name.toLowerCase();
		for (const [cookieName, cookie] of this.cookies) {
			if (cookieName.toLowerCase() === lowerName) return cookie.value;
		}
		return undefined;
	}

	names() {
		return [...this.cookies.keys()].sort();
	}

	serialize(): StoredCookie[] {
		return [...this.cookies.entries()]
			.map(([name, cookie]) => ({ name, ...cookie }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}

class ScheduleRequestError extends Error {
	constructor(
		message: string,
		readonly authFailed = false,
	) {
		super(message);
		this.name = "ScheduleRequestError";
	}
}

function getSetCookieHeaders(headers: Headers) {
	const withGetSetCookie = headers as Headers & {
		getSetCookie?: () => string[];
	};
	if (typeof withGetSetCookie.getSetCookie === "function") {
		return withGetSetCookie.getSetCookie();
	}

	const combined = headers.get("set-cookie");
	if (!combined) return [];
	return combined.split(/,(?=\s*[^;,]+=)/).map((header) => header.trim());
}

async function fetchWithCookies(
	jar: CookieJar,
	url: string,
	init: RequestInit = {},
) {
	let currentUrl = url;
	let currentInit = init;

	for (let redirects = 0; redirects < 10; redirects++) {
		const headers = new Headers(currentInit.headers);
		const cookieHeader = jar.header(currentUrl);
		if (cookieHeader) headers.set("Cookie", cookieHeader);

		const response = await fetch(currentUrl, {
			...currentInit,
			headers,
			redirect: "manual",
		});
		jar.store(response.headers, currentUrl);

		if (![301, 302, 303, 307, 308].includes(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;

		currentUrl = new URL(location, currentUrl).toString();
		currentInit =
			response.status === 303
				? { method: "GET", headers: currentInit.headers }
				: currentInit;
	}

	throw new Error(`Too many redirects while fetching ${url}`);
}

function parseInputFields(html: string) {
	const fields = new URLSearchParams();
	const inputPattern = /<input\b[^>]*>/gi;

	for (const [input] of html.matchAll(inputPattern)) {
		const attrs = parseAttributes(input);
		const name = attrs.name;
		if (!name) continue;

		fields.set(name, attrs.value ?? "");
	}

	return fields;
}

function parseAttributes(tag: string) {
	const attrs: HtmlAttributes = {};
	const attrPattern =
		/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

	for (const match of tag.matchAll(attrPattern)) {
		const name = match[1];
		if (!name) continue;

		const doubleQuoted = match[2];
		const singleQuoted = match[3];
		const bare = match[4];
		attrs[name.toLowerCase()] = htmlDecode(
			doubleQuoted ?? singleQuoted ?? bare ?? "",
		);
	}

	return attrs;
}

function htmlDecode(value: string) {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">");
}

async function login(config: PortalConfig) {
	const jar = new CookieJar();
	const loginPage = await fetchWithCookies(jar, LOGIN_URL, {
		headers: browserLikeHeaders(),
	});

	if (!loginPage.ok) {
		throw new Error(`Unable to load login page: HTTP ${loginPage.status}`);
	}

	const fields = parseInputFields(await loginPage.text());
	fields.set("usrctrl$txtUsername", config.username);
	fields.set("usrctrl$txtPassword", config.password);
	fields.set("usrctrl$btnSignIn", "Sign In");
	fields.delete("usrctrl$cbAuto");

	const response = await fetchWithCookies(jar, LOGIN_URL, {
		method: "POST",
		headers: {
			...browserLikeHeaders(),
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: BASE_URL,
			Referer: LOGIN_URL,
		},
		body: fields.toString(),
	});

	const body = await response.text();
	if (
		!response.ok ||
		/WELCOME TO THE SERVICE PORTAL|txtPassword|btnSignIn/i.test(body)
	) {
		throw new Error(`Login failed: HTTP ${response.status}`);
	}

	return jar;
}

class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

async function loadConfig() {
	let text: string;
	try {
		text = await readFile(CONFIG_PATH, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			throw new ConfigError(
				`Config file is missing at ${CONFIG_PATH}. Run \`tw-portal config\` to create it.`,
			);
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ConfigError(
			`Config file is invalid at ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}. Run \`tw-portal config\` to recreate it.`,
		);
	}

	const config = parseConfig(parsed);
	if (!config) {
		throw new ConfigError(
			`Config file is incomplete at ${CONFIG_PATH}. Run \`tw-portal config\` to recreate it.`,
		);
	}

	return config;
}

function parseConfig(value: unknown): PortalConfig | null {
	type ConfigShape = Partial<Record<keyof PortalConfig, unknown>>;

	if (!isRecord(value)) return null;

	const candidate: ConfigShape = value;
	const username = readConfigString(candidate.username);
	const password = decodeConfigPassword(candidate.password);
	const name = readConfigString(candidate.name);
	const company = readConfigString(candidate.company);
	const licensePlate = readConfigString(candidate.license_plate);
	const makeModel = readConfigString(candidate.make_model);
	const phone = readConfigString(candidate.phone);

	if (
		!username ||
		!password ||
		!name ||
		!company ||
		!licensePlate ||
		!makeModel ||
		!phone
	) {
		return null;
	}

	return {
		username,
		password,
		name,
		company,
		license_plate: licensePlate,
		make_model: makeModel,
		phone,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readConfigString(value: unknown) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function decodeConfigPassword(value: unknown) {
	const encoded = readConfigString(value);
	if (!encoded) return null;

	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	if (!decoded || Buffer.from(decoded, "utf8").toString("base64") !== encoded) {
		return null;
	}

	return decoded;
}

async function promptForConfig() {
	if (!stdin.isTTY) return readConfigFromStdin();

	const reader = createInterface({ input: stdin, output: stdout });
	const config = {} as PortalConfig;

	try {
		for (const [index, section] of CONFIG_PROMPT_SECTIONS.entries()) {
			if (index > 0) console.log("");
			console.log(section.heading);
			for (const prompt of section.prompts) {
				config[prompt.key] = await promptRequiredValue(reader, prompt.label);
			}
		}
	} finally {
		reader.close();
	}

	return config;
}

async function readConfigFromStdin() {
	const lines = (await Bun.stdin.text()).split(/\r?\n/);
	const config = {} as PortalConfig;

	for (let index = 0; index < CONFIG_PROMPTS.length; index++) {
		const prompt = CONFIG_PROMPTS[index];
		if (!prompt) continue;

		const value = lines[index]?.trim();
		if (!value) throw new Error(`${prompt.label} is required.`);
		config[prompt.key] = value;
	}

	return config;
}

async function promptRequiredValue(
	reader: ReturnType<typeof createInterface>,
	label: string,
) {
	while (true) {
		const value = (await reader.question(`${label}: `)).trim();
		if (value) return value;
		console.error(`${label} is required.`);
	}
}

async function saveConfig(config: PortalConfig) {
	await ensureConfigDir();
	await writeFile(
		CONFIG_PATH,
		`${JSON.stringify({ ...config, password: encodeConfigPassword(config.password) }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await chmod(CONFIG_PATH, 0o600);
}

function encodeConfigPassword(password: string) {
	return Buffer.from(password, "utf8").toString("base64");
}

async function ensureConfigDir() {
	await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
	await chmod(CONFIG_DIR, 0o700);
}

async function loadSessionCache() {
	let text: string;
	try {
		text = await readFile(SESSION_CACHE_PATH, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return null;
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		console.warn(
			`Ignoring invalid session cache at ${SESSION_CACHE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}

	const cache = parseSessionCache(parsed);
	if (!cache) {
		console.warn(`Ignoring malformed session cache at ${SESSION_CACHE_PATH}.`);
		return null;
	}

	const savedAt = Date.parse(cache.savedAt);
	if (Number.isNaN(savedAt) || Date.now() - savedAt > SESSION_TTL_MS)
		return null;

	return CookieJar.from(cache.cookies);
}

async function saveSessionCache(jar: CookieJar) {
	const cache: SessionCache = {
		savedAt: new Date().toISOString(),
		cookies: jar.serialize(),
	};

	await ensureConfigDir();
	await writeFile(SESSION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, {
		mode: 0o600,
	});
	await chmod(SESSION_CACHE_PATH, 0o600);
}

function parseSessionCache(value: unknown): SessionCache | null {
	type SessionCacheShape = {
		savedAt?: unknown;
		cookies?: unknown;
	};

	const candidate = value as SessionCacheShape;
	if (typeof candidate.savedAt !== "string") return null;
	if (!Array.isArray(candidate.cookies)) return null;
	if (!candidate.cookies.every(isStoredCookie)) return null;

	return {
		savedAt: candidate.savedAt,
		cookies: candidate.cookies,
	};
}

function isStoredCookie(value: unknown): value is StoredCookie {
	type StoredCookieShape = {
		name?: unknown;
		value?: unknown;
		domain?: unknown;
		path?: unknown;
		secure?: unknown;
	};

	const candidate = value as StoredCookieShape;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.value === "string" &&
		typeof candidate.domain === "string" &&
		typeof candidate.path === "string" &&
		typeof candidate.secure === "boolean"
	);
}

function isErrnoException(error: unknown): error is Error & { code?: string } {
	return error instanceof Error && "code" in error;
}

function browserLikeHeaders() {
	return {
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
	};
}

async function withAuthenticatedSession<T>(
	config: PortalConfig,
	operation: (jar: CookieJar) => Promise<T>,
) {
	const cachedJar = await loadSessionCache();
	let jar = cachedJar ?? (await login(config));
	let authSource: "cache" | "login" = cachedJar ? "cache" : "login";
	if (!cachedJar) await saveSessionCache(jar);

	try {
		return {
			value: await operation(jar),
			jar,
			authSource,
		};
	} catch (error) {
		if (!cachedJar || !isAuthFailure(error)) throw error;

		jar = await login(config);
		authSource = "login";
		await saveSessionCache(jar);
		return {
			value: await operation(jar),
			jar,
			authSource,
		};
	}
}

async function fetchSchedule(jar: CookieJar, from: Date, to: Date) {
	const url = new URL(API_URL);
	url.searchParams.set("from", from.toISOString());
	url.searchParams.set("reservationId", "");
	for (const resource of RESOURCES)
		url.searchParams.append("resourceIds", resource.id);
	url.searchParams.set("to", to.toISOString());

	const response = await fetchWithCookies(jar, url.toString(), {
		headers: {
			Accept: "application/json, text/plain, */*",
			Referer: `${BASE_URL}/Tenant/TranswesternMidwest/TranswesternMidwest/RR/ResourceReservations.aspx#/new/default`,
		},
	});

	const text = await response.text();
	if (!response.ok) {
		throw new ScheduleRequestError(
			`Schedule request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
			isAuthFailureResponse(response, text),
		);
	}

	if (!isJsonResponse(response)) {
		throw new ScheduleRequestError(
			`Schedule request did not return JSON: ${text.slice(0, 200)}`,
			isAuthFailureResponse(response, text),
		);
	}

	return JSON.parse(text) as ScheduleResponse;
}

async function fetchRequestedForContactId(jar: CookieJar) {
	const response = await fetchWithCookies(jar, RESERVATION_PAGE_URL, {
		headers: browserLikeHeaders(),
	});
	const text = await response.text();

	if (!response.ok || isAuthFailureResponse(response, text)) {
		throw new ScheduleRequestError(
			`Unable to load reservation page: HTTP ${response.status}`,
			isAuthFailureResponse(response, text),
		);
	}

	const match = text.match(
		/var\s+TSI_CONTEXT\s*=\s*\{[\s\S]*?["']?user["']?\s*:\s*\{[\s\S]*?["']?id["']?\s*:\s*(\d+)/,
	);
	if (!match?.[1]) {
		throw new Error(
			"Unable to find requested-for contact id in portal context.",
		);
	}

	return Number(match[1]);
}

async function fetchResourceDetails(jar: CookieJar, resourceId: number) {
	const url = new URL(RESOURCE_DETAILS_API_URL);
	url.searchParams.set("resourceIds", String(resourceId));

	const response = await fetchWithCookies(jar, url.toString(), {
		headers: {
			Accept: "application/json, text/plain, */*",
			Referer: `${RESERVATION_PAGE_URL}#/new/default`,
		},
	});
	const text = await response.text();

	if (!response.ok) {
		throw new ScheduleRequestError(
			`Unable to load resource details: HTTP ${response.status} ${text.slice(0, 200)}`,
			isAuthFailureResponse(response, text),
		);
	}

	if (!isJsonResponse(response)) {
		throw new ScheduleRequestError(
			`Resource details request did not return JSON: ${text.slice(0, 200)}`,
			isAuthFailureResponse(response, text),
		);
	}

	const details = JSON.parse(text) as ReservationResourceDetails[];
	const resource = details.find((item) => item.Id === resourceId);
	if (!resource) throw new Error(`Resource details missing for ${resourceId}.`);
	if (resource.RequireEntireTimeBlock) {
		throw new Error(
			`${resource.Name} requires a predefined time block, which this command does not support yet.`,
		);
	}

	return resource;
}

async function createReservation(jar: CookieJar, payload: ReservationPayload) {
	const xsrfToken = jar.get("TENANT-XSRF-TOKEN");
	if (!xsrfToken) {
		throw new Error(
			"Missing TENANT-XSRF-TOKEN cookie; cannot submit reservation.",
		);
	}

	const response = await fetchWithCookies(jar, RESERVATION_API_URL, {
		method: "POST",
		headers: {
			Accept: "application/json, text/plain, */*",
			"Content-Type": "application/json",
			Referer: `${RESERVATION_PAGE_URL}#/new/default`,
			"TENANT-XSRF-TOKEN": xsrfToken,
		},
		body: JSON.stringify(payload),
	});
	const text = await response.text();

	if (!response.ok) {
		throw new ScheduleRequestError(
			`Reservation request failed: HTTP ${response.status} ${text.slice(0, 500)}`,
			response.status === 401 || response.status === 403,
		);
	}

	const result = parseJsonResponse<ReservationCreateResponse>(
		text,
		"reservation response",
	);
	if (!result.Success || !result.EntityID) {
		throw new Error(`Reservation was rejected: ${describeApiError(result)}`);
	}

	return result;
}

function parseJsonResponse<T>(text: string, label: string) {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(
			`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}; body: ${text.slice(0, 500)}`,
		);
	}
}

function describeApiError(response: ReservationCreateResponse) {
	return (
		response.Message ??
		response.Messages?.join("; ") ??
		JSON.stringify(response.Errors ?? response.ModelState ?? response)
	);
}

function isJsonResponse(response: Response) {
	return (
		response.headers.get("content-type")?.includes("application/json") ?? false
	);
}

function isAuthFailureResponse(response: Response, body: string) {
	return (
		response.status === 401 ||
		response.status === 403 ||
		response.url.toLowerCase().includes("/default.aspx") ||
		/WELCOME TO THE SERVICE PORTAL|txtPassword|btnSignIn/i.test(body)
	);
}

function isAuthFailure(error: unknown) {
	return error instanceof ScheduleRequestError && error.authFailed;
}

function intervalsFromSchedule(schedule: ScheduleResponse) {
	const bookings = (schedule.Bookings ?? []).map((booking) => ({
		kind: "booking" as const,
		resourceId: booking.ResourceId,
		resourceName: booking.ResourceName,
		start: new Date(booking.StartDate),
		end: new Date(booking.EndDate),
	}));
	const unavailable = (schedule.Unavailable ?? []).map((block) => ({
		kind: "unavailable" as const,
		start: new Date(block.StartDate),
		end: new Date(block.EndDate),
	}));
	const firstCome = (schedule.FirstComeFirstServed ?? []).map((block) => ({
		kind: "firstCome" as const,
		start: new Date(block.StartDate),
		end: new Date(block.EndDate),
	}));

	return { bookings, unavailable, firstCome };
}

function availableIntervalsForResource(
	schedule: ScheduleResponse,
	resourceId: number,
	from: Date,
	to: Date,
) {
	const { bookings, unavailable, firstCome } = intervalsFromSchedule(schedule);
	const blocked = [
		...unavailable,
		...firstCome,
		...bookings
			.filter((booking) => booking.resourceId === resourceId)
			.map((booking) => applyReservationBuffer(booking)),
	].sort(
		(a, b) =>
			a.start.getTime() - b.start.getTime() ||
			a.end.getTime() - b.end.getTime(),
	);

	const available: Interval[] = [];
	let cursor = from;

	for (const block of blocked) {
		if (block.end <= cursor || block.start >= to) continue;

		const blockStart = maxDate(block.start, from);
		const blockEnd = minDate(block.end, to);
		if (blockStart > cursor) {
			available.push({ kind: "available", start: cursor, end: blockStart });
		}
		if (blockEnd > cursor) cursor = blockEnd;
	}

	if (cursor < to) {
		available.push({ kind: "available", start: cursor, end: to });
	}

	return available.filter((interval) => interval.end > interval.start);
}

function applyReservationBuffer(interval: Interval): Interval {
	return {
		...interval,
		start: new Date(
			interval.start.getTime() - RESERVATION_BUFFER_MINUTES * 60 * 1000,
		),
		end: new Date(
			interval.end.getTime() + RESERVATION_BUFFER_MINUTES * 60 * 1000,
		),
	};
}

function isAtLeastDuration(interval: Interval, durationMinutes: number) {
	return (
		interval.end.getTime() - interval.start.getTime() >=
		durationMinutes * 60_000
	);
}

function applyMinimumTime(
	interval: Interval,
	minTimeMinutes: number,
): Interval[] {
	const intervals: Interval[] = [];
	let dayStart = startOfLocalDay(interval.start);

	while (dayStart < interval.end) {
		const dayEnd = endOfLocalDay(dayStart);
		const minStart = localMinuteOfDayToUtc(dayStart, minTimeMinutes);
		const start = maxDate(maxDate(interval.start, dayStart), minStart);
		const end = minDate(interval.end, dayEnd);

		if (end > start) intervals.push({ ...interval, start, end });
		dayStart = dayEnd;
	}

	return intervals;
}

function localMinuteOfDayToUtc(date: Date, minuteOfDay: number) {
	const parts = localDateParts(date);
	return zonedDateTimeToUtc(
		parts.year,
		parts.month,
		parts.day,
		Math.floor(minuteOfDay / 60),
		minuteOfDay % 60,
		0,
		TIME_ZONE,
	);
}

function maxDate(a: Date, b: Date) {
	return a > b ? a : b;
}

function minDate(a: Date, b: Date) {
	return a < b ? a : b;
}

function findAvailableResource(
	schedule: ScheduleResponse,
	start: Date,
	end: Date,
) {
	for (const resource of RESOURCES) {
		const resourceId = Number(resource.id);
		const matchingInterval = availableIntervalsForResource(
			schedule,
			resourceId,
			startOfLocalDay(start),
			endOfLocalDay(end),
		).find(
			(interval) =>
				interval.start.getTime() <= start.getTime() &&
				interval.end.getTime() >= end.getTime(),
		);

		if (matchingInterval) return { ...resource, resourceId, matchingInterval };
	}

	return null;
}

function buildReservationPayload(
	resource: ReservationResourceDetails,
	requestedForContactId: number,
	start: Date,
	durationMinutes: number,
	config: PortalConfig,
) {
	return {
		resourceIds: [resource.Id],
		requestedForContactId,
		dateRequired: start.toISOString(),
		durationMinutes,
		answers: buildReservationAnswers(resource, config),
		amenities: [],
		TnCAccepted: true,
		displayPreference: "None",
		resourceAvailabilityIds: [],
		recurrencePattern: [],
	} satisfies ReservationPayload;
}

function buildReservationAnswers(
	resource: ReservationResourceDetails,
	config: PortalConfig,
) {
	const questions = resource.Questions ?? [];
	return questions.map((question) => {
		if (question.QuestionType !== "ShortAnswer") {
			throw new Error(
				`Unsupported required reservation question type ${question.QuestionType} for ${question.QuestionText}.`,
			);
		}

		return {
			...question,
			AnswerText: answerForQuestion(question, config),
		};
	});
}

function answerForQuestion(
	question: ReservationQuestion,
	config: PortalConfig,
) {
	const questionConfig = RESERVATION_QUESTION_CONFIG.find(
		(item) =>
			item.id === question.Id || item.textPattern.test(question.QuestionText),
	);
	if (!questionConfig) {
		throw new Error(
			`No config mapping for reservation question ${question.Id}: ${question.QuestionText}`,
		);
	}

	return config[questionConfig.configKey];
}

function startOfLocalDay(date: Date) {
	const parts = localDateParts(date);
	return zonedDateTimeToUtc(
		parts.year,
		parts.month,
		parts.day,
		0,
		0,
		0,
		TIME_ZONE,
	);
}

function endOfLocalDay(date: Date) {
	const parts = localDateParts(date);
	const localNoon = zonedDateTimeToUtc(
		parts.year,
		parts.month,
		parts.day,
		12,
		0,
		0,
		TIME_ZONE,
	);
	const nextDay = new Date(localNoon.getTime() + 24 * 60 * 60 * 1000);
	const nextParts = localDateParts(nextDay);
	return zonedDateTimeToUtc(
		nextParts.year,
		nextParts.month,
		nextParts.day,
		0,
		0,
		0,
		TIME_ZONE,
	);
}

function localDateParts(date: Date) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value);
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
	};
}

function parseArgs(): CommandOptions {
	const args = Bun.argv.slice(2);

	if (args[0] === "config") return parseConfigArgs(args.slice(1));
	if (args[0] === "reserve") return parseReserveArgs(args.slice(1));
	if (args[0] === "schedule") return parseScheduleArgs(args.slice(1));
	if (args[0] === "version") return parseVersionArgs(args.slice(1));
	if (args[0] === "-v" || args[0] === "--version")
		return parseVersionArgs(args.slice(1));

	return parseScheduleArgs(args);
}

function parseConfigArgs(args: string[]): ConfigOptions {
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		}
		throw new Error(`Unknown config argument: ${arg}`);
	}

	return { command: "config" };
}

function parseVersionArgs(args: string[]): VersionOptions {
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		}
		throw new Error(`Unknown version argument: ${arg}`);
	}

	return { command: "version" };
}

function parseScheduleArgs(args: string[]): ScheduleOptions {
	const options: ScheduleOptions = {
		command: "schedule",
		days: DEFAULT_SCHEDULE_DAYS,
		from: endOfLocalDay(new Date()),
		durationMinutes: 120,
		minTimeMinutes: DEFAULT_SCHEDULE_MIN_TIME_MINUTES,
		json: false,
		showAuth: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		if (arg === "--json") options.json = true;
		else if (arg === "--show-auth") options.showAuth = true;
		else if (arg === "--days")
			options.days = Number(readArgValue(args, ++i, "--days"));
		else if (arg.startsWith("--days="))
			options.days = Number(arg.slice("--days=".length));
		else if (arg === "--from")
			options.from = parseFrom(readArgValue(args, ++i, "--from"));
		else if (arg.startsWith("--from="))
			options.from = parseFrom(arg.slice("--from=".length));
		else if (arg === "--duration" || arg === "--duration-minutes")
			options.durationMinutes = Number(readArgValue(args, ++i, arg));
		else if (arg.startsWith("--duration="))
			options.durationMinutes = Number(arg.slice("--duration=".length));
		else if (arg.startsWith("--duration-minutes="))
			options.durationMinutes = Number(arg.slice("--duration-minutes=".length));
		else if (arg === "--min-time" || arg === "--minimum-time")
			options.minTimeMinutes = parseMinuteOfDay(readArgValue(args, ++i, arg));
		else if (arg.startsWith("--min-time="))
			options.minTimeMinutes = parseMinuteOfDay(
				arg.slice("--min-time=".length),
			);
		else if (arg.startsWith("--minimum-time="))
			options.minTimeMinutes = parseMinuteOfDay(
				arg.slice("--minimum-time=".length),
			);
		else if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isFinite(options.days) || options.days <= 0) {
		throw new Error("--days must be a positive number.");
	}
	if (
		!Number.isFinite(options.durationMinutes) ||
		options.durationMinutes <= 0
	) {
		throw new Error("--duration must be a positive number of minutes.");
	}
	if (
		!Number.isInteger(options.minTimeMinutes) ||
		options.minTimeMinutes < 0 ||
		options.minTimeMinutes > 23 * 60 + 59
	) {
		throw new Error("--min-time must be a valid time of day.");
	}

	return options;
}

function parseReserveArgs(args: string[]): ReserveOptions {
	const options = {
		date: undefined as string | undefined,
		time: undefined as string | undefined,
		durationMinutes: 120,
		durationWasSet: false,
		json: false,
		showAuth: false,
		dryRun: false,
	};
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		if (arg === "--json") options.json = true;
		else if (arg === "--show-auth") options.showAuth = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--date") options.date = readArgValue(args, ++i, "--date");
		else if (arg.startsWith("--date="))
			options.date = arg.slice("--date=".length);
		else if (arg === "--time") options.time = readArgValue(args, ++i, "--time");
		else if (arg.startsWith("--time="))
			options.time = arg.slice("--time=".length);
		else if (arg === "--duration" || arg === "--duration-minutes") {
			options.durationMinutes = Number(readArgValue(args, ++i, arg));
			options.durationWasSet = true;
		} else if (arg.startsWith("--duration=")) {
			options.durationMinutes = Number(arg.slice("--duration=".length));
			options.durationWasSet = true;
		} else if (arg.startsWith("--duration-minutes=")) {
			options.durationMinutes = Number(arg.slice("--duration-minutes=".length));
			options.durationWasSet = true;
		} else if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown reserve argument: ${arg}`);
		} else {
			positionals.push(arg);
		}
	}

	const reserveCodeArg = positionals[0]
		? normalizeReserveCodeArg(positionals[0])
		: undefined;
	if (
		positionals[0]?.startsWith("reserve=") ||
		(reserveCodeArg && isReserveCode(reserveCodeArg))
	) {
		if (positionals.length > 2) {
			throw new Error(
				"A reserve code can only be combined with an optional duration.",
			);
		}
		if (options.date || options.time) {
			throw new Error(
				"A reserve code cannot be combined with --date or --time.",
			);
		}
		if (!reserveCodeArg) throw new Error("Reserve code is empty.");
		if (positionals[1]) {
			if (options.durationWasSet) {
				throw new Error(
					"Specify reserve duration either positionally or with --duration, not both.",
				);
			}
			options.durationMinutes = Number(positionals[1]);
			options.durationWasSet = true;
		}

		if (
			!Number.isFinite(options.durationMinutes) ||
			options.durationMinutes <= 0
		) {
			throw new Error("--duration must be a positive number of minutes.");
		}

		return {
			command: "reserve",
			start: decodeReserveCode(reserveCodeArg),
			durationMinutes: options.durationMinutes,
			json: options.json,
			showAuth: options.showAuth,
			dryRun: options.dryRun,
		};
	}

	options.date ??= positionals[0];
	options.time ??= positionals[1];
	if (positionals[2]) {
		options.durationMinutes = Number(positionals[2]);
		options.durationWasSet = true;
	}

	if (!options.date || !options.time) {
		throw new Error("reserve requires a date and time.");
	}
	if (
		!Number.isFinite(options.durationMinutes) ||
		options.durationMinutes <= 0
	) {
		throw new Error("--duration must be a positive number of minutes.");
	}

	return {
		command: "reserve",
		start: parseLocalDateTime(options.date, options.time),
		durationMinutes: options.durationMinutes,
		json: options.json,
		showAuth: options.showAuth,
		dryRun: options.dryRun,
	};
}

function readArgValue(args: string[], index: number, flag: string) {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

function parseMinuteOfDay(value: string) {
	const time = parseLocalTime(value);
	return time.hour * 60 + time.minute;
}

function formatMinuteOfDay(minuteOfDay: number) {
	return formatTime(localMinuteOfDayToUtc(new Date(0), minuteOfDay));
}

function normalizeReserveCodeArg(value: string) {
	const prefix = "reserve=";
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function encodeReserveCode(start: Date) {
	return String(Math.floor(start.getTime() / 60_000));
}

function decodeReserveCode(value: string) {
	if (!isReserveCode(value)) throw new Error(`Invalid reserve code: ${value}`);

	const minutesSinceEpoch = Number(value);
	if (!Number.isSafeInteger(minutesSinceEpoch)) {
		throw new Error(`Invalid reserve code: ${value}`);
	}

	const start = new Date(minutesSinceEpoch * 60_000);
	if (Number.isNaN(start.getTime())) {
		throw new Error(`Reserve code has an invalid start time: ${value}`);
	}

	return start;
}

function isReserveCode(value: string) {
	return /^\d+$/.test(value);
}

function parseFrom(value: string) {
	const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateMatch) {
		const [, year, month, day] = dateMatch;
		if (!year || !month || !day) {
			throw new Error(`Invalid --from value: ${value}`);
		}

		return zonedDateTimeToUtc(
			Number(year),
			Number(month),
			Number(day),
			0,
			0,
			0,
			TIME_ZONE,
		);
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`Invalid --from value: ${value}`);
	}
	return parsed;
}

function parseLocalDateTime(date: string, time: string) {
	const parsedDate = parseLocalDate(date);
	const parsedTime = parseLocalTime(time);
	return zonedDateTimeToUtc(
		parsedDate.year,
		parsedDate.month,
		parsedDate.day,
		parsedTime.hour,
		parsedTime.minute,
		0,
		TIME_ZONE,
	);
}

function parseLocalDate(value: string) {
	const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (isoMatch) {
		const [, year, month, day] = isoMatch;
		if (!year || !month || !day) throw new Error(`Invalid date: ${value}`);
		return { year: Number(year), month: Number(month), day: Number(day) };
	}

	const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (slashMatch) {
		const [, month, day, year] = slashMatch;
		if (!year || !month || !day) throw new Error(`Invalid date: ${value}`);
		return { year: Number(year), month: Number(month), day: Number(day) };
	}

	throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD or M/D/YYYY.`);
}

function parseLocalTime(value: string) {
	const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
	if (!match) {
		throw new Error(`Invalid time: ${value}. Use HH:mm, h:mmam, or h:mmpm.`);
	}

	const [, hourText, minuteText = "0", meridiem] = match;
	if (!hourText) throw new Error(`Invalid time: ${value}`);

	let hour = Number(hourText);
	const minute = Number(minuteText);
	if (minute < 0 || minute > 59) throw new Error(`Invalid time: ${value}`);

	if (meridiem) {
		if (hour < 1 || hour > 12) throw new Error(`Invalid time: ${value}`);
		hour %= 12;
		if (meridiem.toLowerCase() === "pm") hour += 12;
	} else if (hour < 0 || hour > 23) {
		throw new Error(`Invalid time: ${value}`);
	}

	return { hour, minute };
}

function zonedDateTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string,
) {
	const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	let offset = timeZoneOffset(new Date(targetUtc), timeZone);
	offset = timeZoneOffset(new Date(targetUtc - offset), timeZone);
	return new Date(targetUtc - offset);
}

function timeZoneOffset(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(
		value("year"),
		value("month") - 1,
		value("day"),
		value("hour"),
		value("minute"),
		value("second"),
	);
	return asUtc - date.getTime();
}

function printUsage() {
	console.log(`tw-portal checks Transwestern charger availability and can reserve an available charger without opening a browser.

Usage:
  tw-portal <command> [options]
  tw-portal [schedule options]

Commands:
  config
    Create or replace the local portal config.

    Usage:
      tw-portal config

  schedule
    Show charger availability. This is the default command when no subcommand
    is provided. By default, it starts at local midnight tomorrow and only shows
    windows at least 120 minutes long beginning at or after 8:00am.

    Usage:
      tw-portal schedule [options]
      tw-portal [options]

    Options:
      --from YYYY-MM-DD|ISO       Start date or timestamp.
      --days 14                   Number of days to search.
      --duration 120              Minimum available window length in minutes.
      --min-time 8:00am           Earliest local start time to show each day.
      --json                      Print JSON output.
      --show-auth                 Print authentication/cache details.

  reserve
    Reserve the first available charger in CAR #1, then CAR #2 order. Use a
    numeric reserve= code from schedule output, or provide a date and time.

    Usage:
      tw-portal reserve <reserve-code> [durationMinutes] [options]
      tw-portal reserve <YYYY-MM-DD|M/D/YYYY> <HH:mm|h:mmam> [durationMinutes] [options]
      tw-portal reserve --date YYYY-MM-DD --time HH:mm [--duration 120] [options]

    Options:
      --dry-run                   Validate the reservation without creating it.
      --json                      Print JSON output.
      --show-auth                 Print authentication/cache details.

  version
    Print the CLI version, build date, and git commit.

    Usage:
      tw-portal version
      tw-portal --version`);
}

function formatVersionText(result: VersionResult) {
	return [
		`Version: ${result.version}`,
		`Build date: ${result.buildDate}`,
		`Git commit: ${result.gitCommit}`,
	].join("\n");
}

function formatBorderlessTable(
	rows: string[][],
	rightAlignedColumns = new Set<number>(),
) {
	const widths = rows[0]?.map((_, columnIndex) =>
		Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
	);
	if (!widths) return "";

	return rows
		.map((row) =>
			row
				.map((cell, columnIndex) => {
					const width = widths[columnIndex] ?? 0;
					return rightAlignedColumns.has(columnIndex)
						? cell.padStart(width)
						: cell.padEnd(width);
				})
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

function formatText(
	result: Awaited<ReturnType<typeof buildScheduleResult>>,
	showAuth: boolean,
) {
	const lines = [
		`Transwestern charger availability (${formatDateTime(result.from)} to ${formatDateTime(result.to)}, ${result.durationMinutes}+ minutes, after ${result.minimumTime})`,
	];

	appendAuthLines(lines, result, showAuth);

	const availableByStart = new Map<
		string,
		(typeof result.resources)[number]["available"][number]
	>();
	for (const interval of result.resources.flatMap(
		(resource) => resource.available,
	)) {
		const existing = availableByStart.get(interval.start);
		if (!existing || new Date(interval.end) > new Date(existing.end)) {
			availableByStart.set(interval.start, interval);
		}
	}

	const available = [...availableByStart.values()].sort(
		(a, b) =>
			new Date(a.start).getTime() - new Date(b.start).getTime() ||
			new Date(a.end).getTime() - new Date(b.end).getTime(),
	);

	lines.push("");
	if (available.length === 0) {
		lines.push("No available windows found.");
	} else {
		lines.push(
			formatBorderlessTable(
				[
					["Date", "Start Time", "End Time", "Reserve Code"],
					...available.map((interval) => [
						formatDate(interval.start),
						formatTime(interval.start),
						formatTime(interval.end),
						interval.reserveCode,
					]),
				],
				new Set([1, 2, 3]),
			),
		);
	}

	return lines.join("\n");
}

function formatReserveText(
	result: Awaited<ReturnType<typeof buildReserveResult>>,
	showAuth: boolean,
) {
	const action = result.dryRun ? "Reservation dry run" : "Reservation created";
	const lines = [
		`${action}: ${result.resource.name} from ${formatDateTime(result.start)} to ${formatDateTime(result.end)}`,
	];
	if (result.reservationId)
		lines.push(`Reservation ID: ${result.reservationId}`);
	appendAuthLines(lines, result, showAuth);
	return lines.join("\n");
}

async function buildVersionResult(): Promise<VersionResult> {
	return {
		version: readInjectedVersion() ?? (await readPackageVersion()),
		buildDate: readInjectedBuildDate() ?? "unknown",
		gitCommit: readInjectedGitCommit() ?? (await readGitCommit()),
	};
}

function readBuildMetadataValue(value: string) {
	const trimmed = value.trim();
	return trimmed || null;
}

function readInjectedVersion() {
	if (typeof TW_PORTAL_VERSION !== "string") return null;
	return readBuildMetadataValue(TW_PORTAL_VERSION);
}

function readInjectedBuildDate() {
	if (typeof TW_PORTAL_BUILD_DATE !== "string") return null;
	return readBuildMetadataValue(TW_PORTAL_BUILD_DATE);
}

function readInjectedGitCommit() {
	if (typeof TW_PORTAL_GIT_COMMIT !== "string") return null;
	return readBuildMetadataValue(TW_PORTAL_GIT_COMMIT);
}

async function readPackageVersion() {
	try {
		const packageJson = (await Bun.file(
			new URL("./package.json", import.meta.url),
		).json()) as PackageMetadata;
		if (typeof packageJson.version === "string" && packageJson.version.trim()) {
			return packageJson.version.trim();
		}
	} catch {
		// Fall through to the printable unknown value below.
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

function appendAuthLines(
	lines: string[],
	result: {
		authSource?: "cache" | "login";
		cookieNames?: string[];
		sessionCachePath?: string;
		sessionTtlHours?: number;
	},
	showAuth: boolean,
) {
	if (!showAuth) return;

	const cookieNames = result.cookieNames ?? [];
	const authSource = result.authSource ? ` via ${result.authSource}` : "";
	lines.push(
		`Authenticated${authSource} with cookies: ${cookieNames.join(", ")}`,
	);
	if (result.sessionCachePath && result.sessionTtlHours) {
		lines.push(
			`Session cache: ${result.sessionCachePath} (${result.sessionTtlHours}h TTL)`,
		);
	}
}

async function buildScheduleResult(options: ScheduleOptions) {
	const config = await loadConfig();
	const from = options.from;
	const to = new Date(from.getTime() + options.days * 24 * 60 * 60 * 1000);
	const session = await withAuthenticatedSession(config, (jar) =>
		fetchSchedule(jar, from, to),
	);
	const schedule = session.value;
	const { bookings, unavailable, firstCome } = intervalsFromSchedule(schedule);

	return {
		from: from.toISOString(),
		to: to.toISOString(),
		durationMinutes: options.durationMinutes,
		minimumTime: formatMinuteOfDay(options.minTimeMinutes),
		...(options.showAuth
			? {
					authSource: session.authSource,
					cookieNames: session.jar.names(),
					sessionCachePath: SESSION_CACHE_PATH,
					sessionTtlHours: SESSION_TTL_MS / 60 / 60 / 1000,
				}
			: {}),
		resources: RESOURCES.map((resource) => {
			const resourceId = Number(resource.id);
			return {
				...resource,
				available: availableIntervalsForResource(schedule, resourceId, from, to)
					.flatMap((interval) =>
						applyMinimumTime(interval, options.minTimeMinutes),
					)
					.filter((interval) =>
						isAtLeastDuration(interval, options.durationMinutes),
					)
					.map((interval) => ({
						...serializeInterval(interval),
						reserveCode: encodeReserveCode(interval.start),
					})),
				bookings: bookings
					.filter((booking) => booking.resourceId === resourceId)
					.map(serializeInterval),
			};
		}),
		unavailable: unavailable.map(serializeInterval),
		firstComeFirstServed: firstCome.map(serializeInterval),
		rawCounts: {
			bookings: schedule.Bookings?.length ?? 0,
			unavailable: schedule.Unavailable?.length ?? 0,
			firstComeFirstServed: schedule.FirstComeFirstServed?.length ?? 0,
			availableTimeBlocks: schedule.AvailableTimeBlocks?.length ?? 0,
		},
	};
}

async function buildReserveResult(options: ReserveOptions) {
	const config = await loadConfig();
	const start = options.start;
	const end = new Date(start.getTime() + options.durationMinutes * 60 * 1000);
	const scheduleFrom = startOfLocalDay(start);
	const scheduleTo = endOfLocalDay(end);

	const session = await withAuthenticatedSession(config, async (jar) => {
		const schedule = await fetchSchedule(jar, scheduleFrom, scheduleTo);
		const selectedResource = findAvailableResource(schedule, start, end);
		if (!selectedResource) {
			throw new Error(
				`No charger is available for ${formatDateTime(start)} to ${formatDateTime(end)}.`,
			);
		}

		const requestedForContactId = await fetchRequestedForContactId(jar);
		const resourceDetails = await fetchResourceDetails(
			jar,
			selectedResource.resourceId,
		);
		const payload = buildReservationPayload(
			resourceDetails,
			requestedForContactId,
			start,
			options.durationMinutes,
			config,
		);

		return {
			payload,
			resource: {
				id: selectedResource.id,
				name: selectedResource.name,
			},
		};
	});

	const createResponse = options.dryRun
		? undefined
		: await createReservation(session.jar, session.value.payload);

	return {
		start: start.toISOString(),
		end: end.toISOString(),
		durationMinutes: options.durationMinutes,
		dryRun: options.dryRun,
		reservationId: createResponse?.EntityID,
		resource: session.value.resource,
		...(options.showAuth
			? {
					authSource: session.authSource,
					cookieNames: session.jar.names(),
					sessionCachePath: SESSION_CACHE_PATH,
					sessionTtlHours: SESSION_TTL_MS / 60 / 60 / 1000,
				}
			: {}),
	};
}

function serializeInterval(interval: Interval) {
	return {
		kind: interval.kind,
		start: interval.start.toISOString(),
		end: interval.end.toISOString(),
		startLocal: formatDateTime(interval.start),
		endLocal: formatDateTime(interval.end),
	};
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: TIME_ZONE,
	weekday: "short",
	month: "short",
	day: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: TIME_ZONE,
	hour: "numeric",
	minute: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: TIME_ZONE,
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
});

function formatDate(date: Date | string) {
	return dateFormatter.format(new Date(date));
}

function formatTime(date: Date | string) {
	return timeFormatter.format(new Date(date));
}

function formatDateTime(date: Date | string) {
	return dateTimeFormatter.format(new Date(date));
}

try {
	const options = parseArgs();
	if (options.command === "config") {
		const config = await promptForConfig();
		await saveConfig(config);
		console.log(`Wrote config to ${CONFIG_PATH}`);
	} else if (options.command === "version") {
		console.log(formatVersionText(await buildVersionResult()));
	} else if (options.command === "reserve") {
		const result = await buildReserveResult(options);
		console.log(
			options.json
				? JSON.stringify(result, null, 2)
				: formatReserveText(result, options.showAuth),
		);
	} else {
		const result = await buildScheduleResult(options);
		console.log(
			options.json
				? JSON.stringify(result, null, 2)
				: formatText(result, options.showAuth),
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
