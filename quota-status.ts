import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "quota-status";
const LINE_WIDGET_KEY = "above-input-status";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_WORKSPACE_URL = "https://opencode.ai/workspace/wrk_01KPP8RH950PMGAGTSKWAJQXSQ/go";
const OPENCODE_COOKIE_PATH = join(homedir(), ".pi", "agent", "opencode-cookie.txt");

type AboveInputStatus = {
	left?: string;
	right?: string;
};

const getAboveInputStatus = (): AboveInputStatus => {
	const globalState = globalThis as typeof globalThis & { __piAboveInputStatus?: AboveInputStatus };
	globalState.__piAboveInputStatus ??= {};
	return globalState.__piAboveInputStatus;
};

const setAboveInputPart = (ctx: ExtensionContext, part: "left" | "right", text: string | undefined): void => {
	const status = getAboveInputStatus();
	status[part] = text;
	ctx.ui.setWidget(LINE_WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) => {
			const left = status.left;
			const right = status.right;
			if (!left && !right) return [];
			if (!left) {
				const gap = Math.max(0, width - right!.length);
				return [" ".repeat(gap) + truncateToWidth(theme.fg("dim", right!), width, "")];
			}
			if (!right) return [truncateToWidth(theme.fg("dim", left), width, "")];

			const gap = width - left.length - right.length;
			if (gap >= 2) return [theme.fg("dim", left) + " ".repeat(gap) + theme.fg("dim", right)];
			return [truncateToWidth(theme.fg("dim", left), width, ""), truncateToWidth(theme.fg("dim", right), width, "")];
		},
		invalidate: () => {},
	}));
};

type QuotaWindow = {
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

let activeProvider: string | undefined;
let quotaWindows: QuotaWindow[] = [];
let refreshInFlight: Promise<void> | undefined;

const FETCH_TIMEOUT_MS = 15_000;

const fetchWithTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

const isSupportedProvider = (provider: string | undefined): boolean => provider === "openai-codex" || provider === "opencode-go";

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

const renderQuota = (): string | undefined => {
	if (!isSupportedProvider(activeProvider) || quotaWindows.length === 0) return undefined;
	return quotaWindows
		.map((item) => `${item.label} ${bar(item.percentLeft)} ${Math.round(item.percentLeft)}% left${resetSuffix(item)}`)
		.join(" | ");
};

const updateWidget = (ctx: ExtensionContext): void => {
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	setAboveInputPart(ctx, "right", renderQuota());
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

// --- Auth readers ---

const readProviderAuth = (provider: string): { token: string; accountId?: string } | undefined => {
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

const readOpenCodeCookie = (): string | undefined => {
	try {
		if (!existsSync(OPENCODE_COOKIE_PATH)) return undefined;
		return readFileSync(OPENCODE_COOKIE_PATH, "utf8").trim();
	} catch {
		return undefined;
	}
};

// --- Label derivation ---

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

// --- ChatGPT wham/usage endpoint ---

const fetchQuotaFromWham = async (auth: { token: string; accountId?: string }): Promise<QuotaWindow[]> => {
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

// --- OpenCode web scraper for Go subscription usage ---

type OpenCodeUsage = {
	rollingUsage?: { status: string; resetInSec: number; usagePercent: number };
	weeklyUsage?: { status: string; resetInSec: number; usagePercent: number };
	monthlyUsage?: { status: string; resetInSec: number; usagePercent: number };
};

const fetchQuotaFromOpenCodeWeb = async (): Promise<QuotaWindow[] | "no-cookie" | "fetch-failed" | "parse-failed"> => {
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
		/rollingUsage:\$R\[\d+\]=\{status:"ok",resetInSec:(\d+),usagePercent:(\d+)\},weeklyUsage:\$R\[\d+\]=\{status:"ok",resetInSec:(\d+),usagePercent:(\d+)\},monthlyUsage:\$R\[\d+\]=\{status:"ok",resetInSec:(\d+),usagePercent:(\d+)\}/,
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

// --- Refresh logic ---

const refreshQuota = async (ctx: ExtensionContext): Promise<void> => {
	activeProvider = ctx.model?.provider;
	if (!isSupportedProvider(activeProvider)) {
		quotaWindows = [];
		updateWidget(ctx);
		return;
	}

	if (activeProvider === "openai-codex") {
		const auth = readProviderAuth("openai-codex");
		if (!auth) {
			quotaWindows = [];
			updateWidget(ctx);
			return;
		}
		quotaWindows = await fetchQuotaFromWham(auth);
		updateWidget(ctx);
		return;
	}

	if (activeProvider === "opencode-go") {
		const result = await fetchQuotaFromOpenCodeWeb();
		if (Array.isArray(result)) {
			quotaWindows = result;
			updateWidget(ctx);
			return;
		}

		// Show nothing on failure — the cookie command explains how to set it up.
		quotaWindows = [];
		updateWidget(ctx);
		return;
	}

	quotaWindows = [];
	updateWidget(ctx);
};

const debouncedRefresh = (() => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingCtx: ExtensionContext | undefined;

	return (ctx: ExtensionContext) => {
		pendingCtx = ctx;
		if (timer) return;
		timer = setTimeout(async () => {
			timer = undefined;
			const c = pendingCtx!;
			pendingCtx = undefined;
			if (refreshInFlight) return;
			refreshInFlight = (async () => {
				try {
					await refreshQuota(c);
				} catch {
					quotaWindows = [];
					updateWidget(c);
				} finally {
					refreshInFlight = undefined;
				}
			})();
		}, 300);
	};
})();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		debouncedRefresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		debouncedRefresh(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		debouncedRefresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		debouncedRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		setAboveInputPart(ctx, "right", undefined);
	});

	pi.registerCommand("quota-status", {
		description: "Manage quota-status: cookie <set|check|clear>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0];

			if (sub === "cookie" && parts[1] === "set") {
				const cookieVal = parts.slice(2).join(" ");
				if (!cookieVal) {
					ctx.ui.notify(
						"Usage: /quota-status cookie set <full-cookie-string>\n\nCopy from browser DevTools → Application → Cookies → opencode.ai → copy the Cookie header value (both auth= and oc_locale=en parts).",
						"error",
					);
					return;
				}
				writeFileSync(OPENCODE_COOKIE_PATH, cookieVal, "utf8");
				ctx.ui.notify("OpenCode cookie saved. Refreshing quota…", "info");
				debouncedRefresh(ctx);
				return;
			}

			if (sub === "cookie" && parts[1] === "check") {
				const cookie = readOpenCodeCookie();
				if (!cookie) {
					ctx.ui.notify("No OpenCode cookie set. Use /quota-status cookie set <value> to configure.", "warning");
					return;
				}
				ctx.ui.notify(`Cookie found (${cookie.slice(0, 40)}…). Testing…`, "info");
				const result = await fetchQuotaFromOpenCodeWeb();
				if (Array.isArray(result)) {
					const bars = result.map((w) => `${w.label} ${Math.round(w.percentLeft)}% left`).join(", ");
					ctx.ui.notify(`Cookie works! Quota: ${bars}`, "info");
				} else if (result === "fetch-failed") {
					ctx.ui.notify("Cookie expired or invalid. Refresh it from browser and use /quota-status cookie set.", "error");
				} else if (result === "parse-failed") {
					ctx.ui.notify("Could not parse usage data from the workspace page. The page format may have changed.", "error");
				} else {
					ctx.ui.notify("No cookie configured. Use /quota-status cookie set <value>.", "warning");
				}
				return;
			}

			if (sub === "cookie" && parts[1] === "clear") {
				try {
					writeFileSync(OPENCODE_COOKIE_PATH, "", "utf8");
				} catch { /* ignore */ }
				ctx.ui.notify("OpenCode cookie cleared.", "info");
				debouncedRefresh(ctx);
				return;
			}

			ctx.ui.notify(
				"Usage: /quota-status cookie set <value> | /quota-status cookie check | /quota-status cookie clear\n\nTo get the cookie: open https://opencode.ai/workspace/wrk_01KPP8RH950PMGAGTSKWAJQXSQ/go in your browser, open DevTools → Application → Cookies → opencode.ai, copy the full Cookie header (auth=...; oc_locale=en), and paste it with: /quota-status cookie set auth=...; oc_locale=en",
				"info",
			);
		},
	});
}
