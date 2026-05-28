import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/dist/core/keybindings.js";

const CUSTOM_TYPE = "message-stash";
const INDICATOR_KEY = "message-stash";
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

type StashRecord = {
	id: string;
	text: string;
	createdAt: number;
};

type StashEvent =
	| { action: "stash"; item: StashRecord }
	| { action: "pop"; id: string };

let stashedMessages: StashRecord[] = [];

const pluralize = (count: number): string => `${count} stashed message${count === 1 ? "" : "s"}`;

const updateIndicator = (ctx: ExtensionContext): void => {
	ctx.ui.setStatus(INDICATOR_KEY, undefined);
	ctx.ui.setWidget(INDICATOR_KEY, undefined);
	setAboveInputPart(ctx, "left", stashedMessages.length > 0 ? pluralize(stashedMessages.length) : undefined);
};

const isStashEvent = (data: unknown): data is StashEvent => {
	if (!data || typeof data !== "object") return false;
	const value = data as Record<string, unknown>;
	if (value.action === "pop") return typeof value.id === "string";
	if (value.action !== "stash") return false;
	const item = value.item as Record<string, unknown> | undefined;
	return !!item && typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "number";
};

const restoreStash = (ctx: ExtensionContext): void => {
	const restored: StashRecord[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isStashEvent(data)) continue;
		if (data.action === "stash") {
			restored.push(data.item);
		} else {
			const index = restored.findIndex((item) => item.id === data.id);
			if (index !== -1) restored.splice(index, 1);
		}
	}
	stashedMessages = restored;
	updateIndicator(ctx);
};

const appendStash = (pi: ExtensionAPI, item: StashRecord): void => {
	stashedMessages.push(item);
	pi.appendEntry(CUSTOM_TYPE, { action: "stash", item } satisfies StashEvent);
};

const popStash = (pi: ExtensionAPI, id: string): StashRecord | undefined => {
	const index = stashedMessages.findIndex((item) => item.id === id);
	if (index === -1) return undefined;
	const [item] = stashedMessages.splice(index, 1);
	pi.appendEntry(CUSTOM_TYPE, { action: "pop", id } satisfies StashEvent);
	return item;
};

class StashPicker implements Component {
	private selected = 0;
	private query = "";
	private items: StashRecord[];

	constructor(
		items: StashRecord[],
		private readonly tui: TUI,
		private readonly theme: { fg(color: string, text: string): string; bg(color: string, text: string): string },
		private readonly done: (id: string | null) => void,
	) {
		this.items = items;
	}

	handleInput(data: string): void {
		const filtered = this.filteredItems();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = filtered.length === 0 ? 0 : (this.selected - 1 + filtered.length) % filtered.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = filtered.length === 0 ? 0 : (this.selected + 1) % filtered.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const selected = filtered[this.selected];
			if (selected) this.done(selected.id);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.tui.requestRender();
			return;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.query += data;
			this.selected = 0;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const filtered = this.filteredItems();
		const lines = [
			this.theme.fg("accent", `Search stashed messages: ${this.query || ""}`),
			this.theme.fg("dim", "↑↓ navigate • enter/space pop • esc cancel"),
		];
		if (filtered.length === 0) {
			lines.push(this.theme.fg("warning", "No matching stashed messages"));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}
		for (let index = 0; index < Math.min(filtered.length, 10); index++) {
			const item = filtered[index]!;
			const prefix = index === this.selected ? "→ " : "  ";
			const line = truncateToWidth(prefix + item.text.replace(/[\r\n]+/g, " "), width, "…");
			lines.push(index === this.selected ? this.theme.bg("selectedBg", line) : line);
		}
		if (filtered.length > 10) lines.push(this.theme.fg("dim", `  (${this.selected + 1}/${filtered.length})`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}

	private filteredItems(): StashRecord[] {
		const query = this.query.trim().toLowerCase();
		const filtered = query ? this.items.filter((item) => item.text.toLowerCase().includes(query)) : this.items;
		if (this.selected >= filtered.length) this.selected = Math.max(0, filtered.length - 1);
		return filtered;
	}
}

const pickStash = async (ctx: ExtensionContext): Promise<string | null> => {
	const newestFirst = [...stashedMessages].reverse();
	return ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => new StashPicker(newestFirst, tui, theme, done),
		{ overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", minWidth: 48 } },
	);
};

const stashOrPop = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	const currentText = ctx.ui.getEditorText();
	if (currentText.trim().length > 0) {
		appendStash(pi, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: currentText, createdAt: Date.now() });
		ctx.ui.setEditorText("");
		updateIndicator(ctx);
		return;
	}

	if (stashedMessages.length === 0) {
		ctx.ui.notify("No stashed messages", "info");
		return;
	}

	const selectedId = stashedMessages.length === 1 ? stashedMessages[0]!.id : await pickStash(ctx);
	if (!selectedId) return;

	const item = popStash(pi, selectedId);
	if (!item) return;
	ctx.ui.setEditorText(item.text);
	updateIndicator(ctx);
};

class MessageStashEditor extends CustomEditor {
	private handlingStash = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly onStash: () => Promise<void>,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("s"))) {
			if (!this.handlingStash) {
				this.handlingStash = true;
				void this.onStash().finally(() => {
					this.handlingStash = false;
				});
			}
			return;
		}
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restoreStash(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new MessageStashEditor(tui, theme, keybindings, () => stashOrPop(pi, ctx)));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(INDICATOR_KEY, undefined);
		ctx.ui.setWidget(INDICATOR_KEY, undefined);
		setAboveInputPart(ctx, "left", undefined);
		ctx.ui.setEditorComponent(undefined);
	});
}
