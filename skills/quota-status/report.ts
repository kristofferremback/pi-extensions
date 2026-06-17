import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getQuotaForProvider, isSupportedProvider, type QuotaWindow } from "../../lib/quota-reader";

const BAR_WIDTH = 24;

const readDefaultProvider = (): string | undefined => {
	try {
		const settings = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".pi", "agent", "settings.json"), "utf8")) as {
			defaultProvider?: string;
		};
		return settings.defaultProvider;
	} catch {
		return undefined;
	}
};

const formatBar = (percentLeft: number): string => {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percentLeft / 100) * BAR_WIDTH)));
	return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
};

const formatDuration = (ms: number): string => {
	if (!Number.isFinite(ms)) return "unknown";
	const absMs = Math.abs(ms);
	const totalMinutes = Math.round(absMs / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes - days * 24 * 60) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes || parts.length === 0) parts.push(`${minutes}m`);
	return `${ms < 0 ? "overdue by" : "in"} ${parts.join(" ")}`;
};

const formatReset = (resetAtMs: number | undefined): string => {
	if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return "unknown";
	const resetAt = new Date(resetAtMs);
	return `${resetAt.toLocaleString()} (${formatDuration(resetAtMs - Date.now())}; ${resetAt.toISOString()})`;
};

const formatWindow = (window: QuotaWindow): string => {
	const percentLeft = Math.max(0, Math.min(100, window.percentLeft));
	const percentUsed = Math.max(0, Math.min(100, 100 - percentLeft));
	return [
		`- ${window.label}`,
		`  Remaining: ${percentLeft.toFixed(1)}%`,
		`  Used:      ${percentUsed.toFixed(1)}%`,
		`  Meter:     ${formatBar(percentLeft)}`,
		`  Reset:     ${formatReset(window.resetAtMs)}`,
	].join("\n");
};

const providerArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const provider = providerArg ?? readDefaultProvider();

if (!provider || !isSupportedProvider(provider)) {
	console.error(`Unsupported or unknown provider: ${provider ?? "(none)"}`);
	console.error("Supported providers: openai-codex, opencode-go");
	console.error("Set a defaultProvider in ~/.pi/agent/settings.json or pass a provider as an argument.");
	process.exit(1);
}

const result = await getQuotaForProvider(provider);
if (!result.ok) {
	console.error(result.error);
	process.exit(1);
}

if (result.windows.length === 0) {
	console.log(`Quota for ${result.provider}: no quota windows available.`);
} else {
	console.log(
		[
			`Quota for ${result.provider}`,
			`Checked: ${new Date().toLocaleString()} (${new Date().toISOString()})`,
			`Windows: ${result.windows.length}`,
			"",
			...result.windows.map(formatWindow),
		].join("\n"),
	);
}
