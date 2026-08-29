import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_WORKSPACE_URL = "https://opencode.ai/workspace/wrk_01KPP8RH950PMGAGTSKWAJQXSQ/go";
export const OPENCODE_COOKIE_PATH = join(homedir(), ".pi", "agent", "opencode-cookie.txt");
const FETCH_TIMEOUT_MS = 15_000;

export type QuotaWindow = {
	label: string;
	percentLeft: number;
	resetAtMs?: number;
};

type CodexCliAuth = {
	tokens?: {
		access_token?: string;
		account_id?: string;
	};
};

type PiProviderAuth = {
	type?: "oauth" | "api_key";
	access?: string;
	key?: string;
	accountId?: string;
	account_id?: string;
};

type PiAuthFile = {
	"openai-codex"?: PiProviderAuth;
	"opencode-go"?: PiProviderAuth;
};

type UsageWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};

type UsageResponse = {
	plan_type?: string;
	rate_limit?: {
		primary_window?: UsageWindow;
		secondary_window?: UsageWindow;
	};
	additional_rate_limits?: Array<{
		limit_name?: string;
		metered_feature?: string;
		rate_limit?: {
			primary_window?: UsageWindow;
			secondary_window?: UsageWindow;
		};
	}>;
};

type OpenCodeUsage = {
	rollingUsage?: { status: string; resetInSec: number; usagePercent: number };
	weeklyUsage?: { status: string; resetInSec: number; usagePercent: number };
	monthlyUsage?: { status: string; resetInSec: number; usagePercent: number };
};

const fetchWithTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

const percentLeftFromUsed = (usedPercent: number | undefined): number | undefined => {
	if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined;
	return Math.max(0, Math.min(100, 100 - usedPercent));
};

const resetAtMsFromWindow = (window: UsageWindow): number | undefined => {
	if (window.reset_at !== undefined && Number.isFinite(window.reset_at)) return window.reset_at * 1000;
	if (window.reset_after_seconds !== undefined && Number.isFinite(window.reset_after_seconds)) {
		return Date.now() + window.reset_after_seconds * 1000;
	}
	return undefined;
};

const labelFromSeconds = (windowSeconds: number | undefined, provider: string): string => {
	if (windowSeconds === undefined) return provider === "opencode-go" ? "Window" : "";

	const SECONDS_PER_HOUR = 3600;
	const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
	const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
	const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
	const ROUNDING_BIAS = 180;

	if (windowSeconds <= SECONDS_PER_DAY + ROUNDING_BIAS) {
		const hours = Math.max(1, Math.round(windowSeconds / SECONDS_PER_HOUR));
		return provider === "opencode-go" ? "Rolling" : `${hours}h`;
	}
	if (windowSeconds <= SECONDS_PER_WEEK + ROUNDING_BIAS) return "Weekly";
	if (windowSeconds <= SECONDS_PER_MONTH + ROUNDING_BIAS) return "Monthly";
	return "Annual";
};

const bar = (percentLeft: number): string => {
	const width = 7;
	const filled = Math.max(0, Math.min(width, Math.round((percentLeft / 100) * width)));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
};

const formatResetTime = (date: Date): string =>
	date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const isSameLocalDay = (a: Date, b: Date): boolean =>
	a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const addLocalDays = (date: Date, days: number): Date => {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + days);
	return copy;
};

const resetSuffix = (item: QuotaWindow): string => {
	if (item.percentLeft >= 30 || item.resetAtMs === undefined || !Number.isFinite(item.resetAtMs)) return "";
	const resetAt = new Date(item.resetAtMs);
	const resetTime = formatResetTime(resetAt);
	const now = new Date();
	if (isSameLocalDay(resetAt, now)) return ` (resets ${resetTime})`;
	if (isSameLocalDay(resetAt, addLocalDays(now, 1))) return ` (resets tomorrow ${resetTime})`;
	const weekday = resetAt.toLocaleDateString([], { weekday: "long" });
	return ` (${weekday} ${resetTime})`;
};

export const renderQuota = (windows: QuotaWindow[]): string | undefined => {
	if (windows.length === 0) return undefined;
	return windows
		.map((item) => `${item.label} ${bar(item.percentLeft)} ${Math.round(item.percentLeft)}% left${resetSuffix(item)}`)
		.join(" | ");
};

export const readProviderAuth = (provider: string): { token: string; accountId?: string } | undefined => {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as PiAuthFile;
		const credential = auth[provider as keyof PiAuthFile];
		if (credential) {
			const token = credential.access ?? credential.key;
			if (token) return { token, accountId: credential.accountId ?? credential.account_id };
		}
	} catch {
		// Fall through.
	}

	if (provider === "openai-codex") {
		try {
			const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as CodexCliAuth;
			const token = auth.tokens?.access_token;
			if (!token) return undefined;
			return { token, accountId: auth.tokens?.account_id };
		} catch {
			return undefined;
		}
	}

	return undefined;
};

export const readOpenCodeCookie = (): string | undefined => {
	try {
		if (!existsSync(OPENCODE_COOKIE_PATH)) return undefined;
		return readFileSync(OPENCODE_COOKIE_PATH, "utf8").trim();
	} catch {
		return undefined;
	}
};

export const fetchQuotaFromWham = async (auth: { token: string; accountId?: string }): Promise<QuotaWindow[]> => {
	let response: Response;
	try {
		response = await fetchWithTimeout(WHAM_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.token}`,
				...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
				originator: "pi",
				"User-Agent": "pi quota-status",
			},
		});
	} catch {
		return [];
	}
	if (!response.ok) return [];

	const usage = (await response.json()) as UsageResponse;
	const windows: QuotaWindow[] = [];

	if (usage.rate_limit?.primary_window) {
		const pct = percentLeftFromUsed(usage.rate_limit.primary_window.used_percent);
		if (pct !== undefined) {
			const label =
				labelFromSeconds(usage.rate_limit.primary_window.limit_window_seconds, "openai-codex") || "5h";
			windows.push({ label, percentLeft: pct, resetAtMs: resetAtMsFromWindow(usage.rate_limit.primary_window) });
		}
	}

	if (usage.rate_limit?.secondary_window) {
		const pct = percentLeftFromUsed(usage.rate_limit.secondary_window.used_percent);
		if (pct !== undefined) {
			const label = labelFromSeconds(usage.rate_limit.secondary_window.limit_window_seconds, "openai-codex") || "Weekly";
			windows.push({ label, percentLeft: pct, resetAtMs: resetAtMsFromWindow(usage.rate_limit.secondary_window) });
		}
	}

	if (usage.additional_rate_limits) {
		for (const additional of usage.additional_rate_limits) {
			if (!additional.rate_limit?.primary_window) continue;
			const pct = percentLeftFromUsed(additional.rate_limit.primary_window.used_percent);
			if (pct === undefined) continue;

			let label = labelFromSeconds(additional.rate_limit.primary_window.limit_window_seconds, "openai-codex");
			if (!label) {
				const name = (additional.limit_name ?? additional.metered_feature ?? "").toLowerCase();
				if (name.includes("month")) label = "Monthly";
				else if (name.includes("week")) label = "Weekly";
				else if (name.includes("5h") || name.includes("rolling") || name.includes("hour")) label = "5h";
				else label = "Monthly";
			}

			if (!windows.some((w) => w.label === label)) {
				windows.push({
					label,
					percentLeft: pct,
					resetAtMs: resetAtMsFromWindow(additional.rate_limit.primary_window),
				});
			}
		}
	}

	return windows;
};

export const fetchQuotaFromOpenCodeWeb = async (): Promise<
	QuotaWindow[] | "no-cookie" | "fetch-failed" | "parse-failed"
> => {
	const cookie = readOpenCodeCookie();
	if (!cookie) return "no-cookie";

	let response: Response;
	try {
		response = await fetchWithTimeout(OPENCODE_WORKSPACE_URL, {
			headers: {
				Cookie: cookie,
				"User-Agent": "pi quota-status",
			},
		});
	} catch {
		return "fetch-failed";
	}
	if (!response.ok) return "fetch-failed";

	const html = await response.text();

	const scriptMatch = html.match(
		/rollingUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:(\d+)\},weeklyUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:(\d+)\},monthlyUsage:\$R\[\d+\]=\{status:"[^"]*",resetInSec:(\d+),usagePercent:(\d+)\}/,
	);
	if (!scriptMatch) return "parse-failed";

	const usage: OpenCodeUsage = {
		rollingUsage: { status: "ok", resetInSec: Number(scriptMatch[1]), usagePercent: Number(scriptMatch[2]) },
		weeklyUsage: { status: "ok", resetInSec: Number(scriptMatch[3]), usagePercent: Number(scriptMatch[4]) },
		monthlyUsage: { status: "ok", resetInSec: Number(scriptMatch[5]), usagePercent: Number(scriptMatch[6]) },
	};

	const windows: QuotaWindow[] = [];
	if (usage.rollingUsage) {
		windows.push({
			label: "Rolling",
			percentLeft: percentLeftFromUsed(usage.rollingUsage.usagePercent) ?? 0,
			resetAtMs: Date.now() + usage.rollingUsage.resetInSec * 1000,
		});
	}
	if (usage.weeklyUsage) {
		windows.push({
			label: "Weekly",
			percentLeft: percentLeftFromUsed(usage.weeklyUsage.usagePercent) ?? 0,
			resetAtMs: Date.now() + usage.weeklyUsage.resetInSec * 1000,
		});
	}
	if (usage.monthlyUsage) {
		windows.push({
			label: "Monthly",
			percentLeft: percentLeftFromUsed(usage.monthlyUsage.usagePercent) ?? 0,
			resetAtMs: Date.now() + usage.monthlyUsage.resetInSec * 1000,
		});
	}

	return windows;
};

export const isSupportedProvider = (provider: string | undefined): boolean =>
	provider === "openai-codex" || provider === "opencode-go";

export type QuotaResult =
	| { ok: true; windows: QuotaWindow[]; provider: string }
	| { ok: false; provider: string; error: string };

export const getQuotaForProvider = async (provider: string | undefined): Promise<QuotaResult> => {
	if (!provider || !isSupportedProvider(provider)) {
		return { ok: false, provider: provider ?? "unknown", error: `Provider "${provider}" is not supported.` };
	}

	if (provider === "openai-codex") {
		const auth = readProviderAuth("openai-codex");
		if (!auth) {
			return { ok: false, provider, error: "No OpenAI auth found in ~/.pi/agent/auth.json or ~/.codex/auth.json" };
		}
		const windows = await fetchQuotaFromWham(auth);
		return { ok: true, provider, windows };
	}

	const result = await fetchQuotaFromOpenCodeWeb();
	if (Array.isArray(result)) {
		return { ok: true, provider, windows: result };
	}
	if (result === "no-cookie") {
		return {
			ok: false,
			provider,
			error: "No OpenCode cookie configured. Use /quota-status cookie set <value> to configure.",
		};
	}
	if (result === "fetch-failed") {
		return { ok: false, provider, error: "Failed to fetch OpenCode workspace page. Cookie may be expired." };
	}
	return { ok: false, provider, error: "Could not parse OpenCode usage data from the workspace page." };
};
