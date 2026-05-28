import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 12_000;

type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

type Config = {
	provider?: "duckduckgo" | "brave";
	braveApiKey?: string;
	timeoutMs?: number;
	maxChars?: number;
};

type Params = {
	action: "search" | "open_page" | "find_in_page";
	query?: string;
	url?: string;
	pattern?: string;
	maxResults?: number;
	maxChars?: number;
};

const config: Config = (() => {
	try {
		return JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "web-search.json"), "utf8")) as Config;
	} catch {
		return {};
	}
})();

const decodeHtml = (text: string): string =>
	text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));

const stripHtml = (html: string): string =>
	decodeHtml(
		html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<!--([\s\S]*?)-->/g, " ")
			.replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

const titleFromHtml = (html: string): string | undefined => {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? stripHtml(match[1]).slice(0, 200) : undefined;
};

const truncate = (text: string, maxChars: number): string =>
	text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}\n\n[truncated ${text.length - maxChars} chars]`;

const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("web_search timed out")), timeoutMs);
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
	return controller.signal;
};

const fetchText = async (url: string, signal: AbortSignal | undefined): Promise<{ text: string; finalUrl: string }> => {
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const response = await fetch(url, {
		signal: withTimeout(signal, timeoutMs),
		headers: {
			"User-Agent": "Pi web_search extension (+https://github.com/earendil-works/pi-coding-agent)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
		},
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	const contentType = response.headers.get("content-type") ?? "";
	if (!/text|html|xml|json|javascript/i.test(contentType)) {
		throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
	}
	return { text: await response.text(), finalUrl: response.url };
};

const normalizeDuckDuckGoUrl = (rawUrl: string): string => {
	try {
		const url = new URL(decodeHtml(rawUrl), "https://duckduckgo.com");
		const uddg = url.searchParams.get("uddg");
		return uddg ? decodeURIComponent(uddg) : url.toString();
	} catch {
		return decodeHtml(rawUrl);
	}
};

const searchDuckDuckGo = async (query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> => {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const { text } = await fetchText(url, signal);
	const results: SearchResult[] = [];
	const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of text.matchAll(resultRegex)) {
		results.push({
			title: stripHtml(match[2]),
			url: normalizeDuckDuckGoUrl(match[1]),
			snippet: stripHtml(match[3]),
		});
		if (results.length >= maxResults) break;
	}

	if (results.length > 0) return results;

	const fallbackRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of text.matchAll(fallbackRegex)) {
		results.push({ title: stripHtml(match[2]), url: normalizeDuckDuckGoUrl(match[1]) });
		if (results.length >= maxResults) break;
	}
	return results;
};

const searchBrave = async (query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> => {
	const apiKey = config.braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY or ~/.pi/agent/web-search.json braveApiKey is required");
	const response = await fetch(
		`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
		{
			signal: withTimeout(signal, config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
		},
	);
	if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}: ${await response.text()}`);
	const body = (await response.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
	return (body.web?.results ?? []).slice(0, maxResults).map((result) => ({
		title: stripHtml(result.title),
		url: result.url,
		snippet: result.description ? stripHtml(result.description) : undefined,
	}));
};

const search = async (query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> => {
	if ((config.provider === "brave" || process.env.BRAVE_SEARCH_API_KEY) && config.provider !== "duckduckgo") {
		return searchBrave(query, maxResults, signal);
	}
	return searchDuckDuckGo(query, maxResults, signal);
};

const formatSearchResults = (query: string, results: SearchResult[]): string => {
	if (results.length === 0) return `No web search results found for: ${query}`;
	return [
		`Web search results for: ${query}`,
		"",
		...results.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			return lines.join("\n");
		}),
	].join("\n");
};

const openPage = async (url: string, maxChars: number, signal: AbortSignal | undefined): Promise<string> => {
	const { text, finalUrl } = await fetchText(url, signal);
	const title = titleFromHtml(text);
	const pageText = stripHtml(text);
	return truncate([title ? `Title: ${title}` : undefined, `URL: ${finalUrl}`, "", pageText].filter(Boolean).join("\n"), maxChars);
};

const findInPage = async (
	url: string,
	pattern: string,
	maxChars: number,
	signal: AbortSignal | undefined,
): Promise<string> => {
	const { text, finalUrl } = await fetchText(url, signal);
	const pageText = stripHtml(text);
	const lowerText = pageText.toLowerCase();
	const lowerPattern = pattern.toLowerCase();
	const snippets: string[] = [];
	let cursor = 0;
	while (snippets.length < 12) {
		const index = lowerText.indexOf(lowerPattern, cursor);
		if (index === -1) break;
		const start = Math.max(0, index - 300);
		const end = Math.min(pageText.length, index + pattern.length + 300);
		snippets.push(pageText.slice(start, end).replace(/\s+/g, " ").trim());
		cursor = index + Math.max(1, pattern.length);
	}
	if (snippets.length === 0) return `No matches for "${pattern}" in ${finalUrl}`;
	return truncate([`Matches for "${pattern}" in ${finalUrl}:`, "", ...snippets.map((s, i) => `${i + 1}. …${s}…`)].join("\n\n"), maxChars);
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web, open a web page, or find text within a web page. Use for current information or when the user asks you to research online.",
		promptSnippet: "web_search: Search the web, open a page, or find text within a page.",
		promptGuidelines: [
			"Use web_search when the user asks for current or external information that is not available in the repo.",
			"For research tasks, search first, then open the most relevant pages before answering.",
			"Cite URLs from web_search results when using web information in the final answer.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("search", { description: "Search the web for query." }),
				Type.Literal("open_page", { description: "Fetch and extract readable text from url." }),
				Type.Literal("find_in_page", { description: "Fetch url and find pattern snippets within it." }),
			]),
			query: Type.Optional(Type.String({ description: "Search query. Required for action=search." })),
			url: Type.Optional(Type.String({ description: "Page URL. Required for action=open_page or action=find_in_page." })),
			pattern: Type.Optional(Type.String({ description: "Text to find. Required for action=find_in_page." })),
			maxResults: Type.Optional(Type.Number({ description: "Maximum search results, default 6, max 10." })),
			maxChars: Type.Optional(Type.Number({ description: "Maximum returned characters for page text/snippets." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params: Params, signal) {
			const maxResults = Math.max(1, Math.min(10, Math.floor(params.maxResults ?? DEFAULT_MAX_RESULTS)));
			const maxChars = Math.max(1_000, Math.min(50_000, Math.floor(params.maxChars ?? config.maxChars ?? DEFAULT_MAX_CHARS)));

			if (params.action === "search") {
				if (!params.query?.trim()) throw new Error("query is required for action=search");
				const results = await search(params.query.trim(), maxResults, signal);
				return { content: [{ type: "text", text: formatSearchResults(params.query.trim(), results) }], details: { results } };
			}

			if (params.action === "open_page") {
				if (!params.url?.trim()) throw new Error("url is required for action=open_page");
				return { content: [{ type: "text", text: await openPage(params.url.trim(), maxChars, signal) }], details: { results: [] } };
			}

			if (!params.url?.trim()) throw new Error("url is required for action=find_in_page");
			if (!params.pattern?.trim()) throw new Error("pattern is required for action=find_in_page");
			return {
				content: [{ type: "text", text: await findInPage(params.url.trim(), params.pattern.trim(), maxChars, signal) }],
				details: { results: [] },
			};
		},
	});
}
