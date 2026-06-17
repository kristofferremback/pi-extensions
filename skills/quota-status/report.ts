import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getQuotaForProvider, isSupportedProvider, renderQuota } from "../../lib/quota-reader";

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

const rendered = renderQuota(result.windows);
if (!rendered) {
	console.log("No quota windows available.");
} else {
	console.log(rendered);
}
