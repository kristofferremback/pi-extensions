import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	fetchQuotaFromOpenCodeWeb,
	getQuotaForProvider,
	isSupportedProvider,
	OPENCODE_COOKIE_PATH,
	readOpenCodeCookie,
	readProviderAuth,
	renderQuota,
	type QuotaWindow,
} from "./lib/quota-reader";

const WIDGET_KEY = "quota-status";
const LINE_WIDGET_KEY = "above-input-status";

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

let activeProvider: string | undefined;
let quotaWindows: QuotaWindow[] = [];
let refreshInFlight: Promise<void> | undefined;

const updateWidget = (ctx: ExtensionContext): void => {
	try {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		setAboveInputPart(ctx, "right", renderQuota(quotaWindows));
	} catch {
		// A delayed refresh may finish after a child session or reload has made
		// its extension context stale. UI cleanup is best-effort in that case.
	}
};

const refreshQuota = async (ctx: ExtensionContext): Promise<void> => {
	activeProvider = ctx.model?.provider;
	if (!isSupportedProvider(activeProvider)) {
		quotaWindows = [];
		updateWidget(ctx);
		return;
	}

	const result = await getQuotaForProvider(activeProvider);
	if (result.ok) {
		quotaWindows = result.windows;
	} else {
		quotaWindows = [];
	}
	updateWidget(ctx);
};

const debouncedRefresh = (() => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingCtx: ExtensionContext | undefined;

	return (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
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
