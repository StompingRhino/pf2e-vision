import { MODULE_ID, LOC, loc as t, LEVELS, LEVEL_COLORS, LEVEL_ICONS, fgFor } from "./constants.mjs";
import { consequences, sameSide } from "./logic.mjs";
import { getSetting, getConfig } from "./settings.mjs";
import * as store from "./store.mjs";
import * as visuals from "./token-visuals.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const UNDO_LIMIT = 10;

let instance = null;

class MatrixApp extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: `${MODULE_ID}-matrix`,
		classes: [MODULE_ID, "pf2ev-app"],
		position: { width: 820, height: "auto" },
		window: { title: `${LOC}.matrix.title`, icon: "fa-solid fa-table-cells", resizable: true },
		actions: {
			brush: MatrixApp.#onBrush,
			undo: MatrixApp.#onUndo,
			fillRow: MatrixApp.#onFillRow,
			fillCol: MatrixApp.#onFillCol,
			toggleAllies: MatrixApp.#onToggleAllies
		}
	};

	static PARTS = {
		main: { template: `modules/${MODULE_ID}/templates/matrix.hbs` }
	};

	#brush = "hidden";
	#collapse = getSetting("matrix.collapseAllies");
	#undo = [];
	#people = [];
	#stroke = null; // Map "target|observer" -> change, only while the pointer is down
	#hl = "";
	#cleanup = [];
	#queue = Promise.resolve(); // store writes run one after another
	#rerender = foundry.utils.debounce(() => {
		if (!this.#stroke) this.render();
	}, 100);

	#skip(o, tg) {
		return this.#collapse && sameSide(o, tg, getSetting("matrix.allyCriterion"));
	}

	async _prepareContext() {
		const cfg = getConfig();
		const tip = getSetting("matrix.tooltip");
		// getCombatTokens(): TokenDocument[] (Token placeables are unwrapped too)
		this.#people = store.getCombatTokens().map((tok) => {
			const doc = tok.document ?? tok;
			const hasPlayerOwner = !!doc.actor?.hasPlayerOwner;
			return {
				id: doc.id,
				name: doc.name,
				initial: [...(doc.name || "?")][0].toUpperCase(),
				alliance: doc.actor?.alliance ?? null,
				hasPlayerOwner,
				side: hasPlayerOwner ? "pc" : "npc"
			};
		});
		const people = this.#people;
		const cellFor = (o, tg) => {
			if (o.id === tg.id) return { self: true };
			if (this.#skip(o, tg)) return { collapsed: true };
			const level = store.getLevel(tg.id, o.id);
			const color = LEVEL_COLORS[level];
			const names = { observer: o.name, target: tg.name };
			const cellTip = t("matrix.cellTip", { ...names, level: t(`level.${level}`) });
			return {
				o: o.id, t: tg.id, level, color, fg: fgFor(color),
				icon: LEVEL_ICONS[level], short: t(`levelShort.${level}`),
				tip: cellTip,
				tooltip: tip ? `${cellTip}. ${MatrixApp.#consequenceText(level, cfg, names)}` : ""
			};
		};
		return {
			empty: !people.length,
			count: people.length,
			tokens: people,
			rows: people.map((o) => ({ ...o, cells: people.map((tg) => cellFor(o, tg)) })),
			brushes: LEVELS.map((level, i) => ({
				level, key: i + 1, on: level === this.#brush,
				color: LEVEL_COLORS[level], fg: fgFor(LEVEL_COLORS[level]),
				icon: LEVEL_ICONS[level], name: t(`level.${level}`)
			})),
			canUndo: this.#undo.length > 0,
			collapse: this.#collapse,
			hotkeys: getSetting("matrix.hotkeys"),
			fillWith: t("matrix.fillWith"),
			rowAll: t("matrix.rowAll"),
			colAll: t("matrix.colAll"),
			collapsedTip: t("matrix.collapsedCell")
		};
	}

	/** Both sides of the consequences; only what the settings enable. */
	static #consequenceText(level, cfg, names) {
		const c = consequences(level, cfg);
		const parts = [];
		if (c.flatDC != null) parts.push(t("tooltip.flat", { ...names, dc: c.flatDC }));
		if (c.offGuard) parts.push(t("tooltip.offGuard", names));
		if (!parts.length) return t("tooltip.none", names);
		let text = parts.join(t("tooltip.separator"));
		if (c.flatDC != null && (level === "concealed" || level === "hidden")) text += `. ${t("tooltip.saves")}`;
		return text;
	}

	_onFirstRender() {
		const el = this.element;
		el.tabIndex = -1;
		const on = (target, type, fn) => {
			target.addEventListener(type, fn);
			this.#cleanup.push(() => target.removeEventListener(type, fn));
		};
		el.focus({ preventScroll: true });
		on(el, "pointerdown", (ev) => {
			if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
			this.#strokeStart(ev);
		});
		on(el, "pointerover", (ev) => this.#hover(ev));
		on(el, "pointerleave", () => this.#highlight(""));
		on(el, "keydown", (ev) => this.#keydown(ev));
		on(window, "pointerup", () => this.#strokeEnd());
		on(window, "pointercancel", () => this.#strokeEnd());
		this.#cleanup.push(store.onChange(() => this.#rerender()));
	}

	_onClose() {
		this.#highlight("");
		this.#cleanup.splice(0).forEach((fn) => fn());
		this.#stroke = null;
		instance = null;
	}

	// --- brush ---------------------------------------------------------------

	#setBrush(level) {
		this.#brush = level;
		for (const b of this.element.querySelectorAll(".pf2ev-brush")) b.setAttribute("aria-pressed", String(b.dataset.level === level));
	}

	#keydown(ev) {
		if (!getSetting("matrix.hotkeys") || ev.ctrlKey || ev.altKey || ev.metaKey) return;
		const level = LEVELS[Number(ev.key) - 1];
		if (!level) return;
		ev.stopPropagation();
		ev.preventDefault();
		this.#setBrush(level);
	}

	static #onBrush(ev, target) {
		this.#setBrush(target.dataset.level);
	}

	// --- stroke: only the DOM is painted, one store call on pointerup -------------

	#paintCell(cell) {
		const { o, t: tg } = cell.dataset;
		const level = this.#brush;
		cell.dataset.level = level;
		cell.style.setProperty("--c", LEVEL_COLORS[level]);
		cell.style.setProperty("--fg", fgFor(LEVEL_COLORS[level]));
		cell.querySelector("img").src = LEVEL_ICONS[level];
		cell.querySelector(".pf2ev-short").textContent = t(`levelShort.${level}`);
		this.#stroke.set(`${tg}|${o}`, { observerId: o, targetId: tg, level });
	}

	#strokeStart(ev) {
		const cell = ev.target.closest?.("[data-cell]");
		if (!cell || ev.button !== 0) return;
		ev.preventDefault();
		this.#stroke = new Map();
		this.#paintCell(cell);
	}

	#strokeEnd() {
		if (!this.#stroke) return;
		const changes = [...this.#stroke.values()];
		this.#stroke = null;
		this.#rerender();
		return this.#commit(changes);
	}

	#enqueue(fn) {
		return (this.#queue = this.#queue.then(fn));
	}

	// A successful write re-renders the window through store.onChange; only a failure renders here.
	#commit(changes) {
		if (!changes.length) return;
		const scene = store.combatScene();
		return this.#enqueue(async () => {
			try {
				const diff = await store.applyChanges(changes, scene);
				if (diff?.length) {
					this.#undo.push({ scene, diff });
					if (this.#undo.length > UNDO_LIMIT) this.#undo.shift();
				}
			} catch (err) {
				console.error(`${MODULE_ID} | applyChanges failed`, err);
				this.render();
			}
		});
	}

	// --- row / column / undo / allies -----------------------------------------------

	#fill(pairs) {
		return this.#commit(
			pairs
				.filter(([o, tg]) => o.id !== tg.id && !this.#skip(o, tg))
				.map(([o, tg]) => ({ observerId: o.id, targetId: tg.id, level: this.#brush }))
		);
	}

	static #onFillRow(ev, target) {
		const o = this.#people.find((p) => p.id === target.dataset.id);
		if (o) return this.#fill(this.#people.map((tg) => [o, tg]));
	}

	static #onFillCol(ev, target) {
		const tg = this.#people.find((p) => p.id === target.dataset.id);
		if (tg) return this.#fill(this.#people.map((o) => [o, tg]));
	}

	static #onUndo() {
		return this.#enqueue(async () => {
			const last = this.#undo.pop();
			if (!last) return;
			try {
				await store.revert(last.diff, last.scene);
			} catch (err) {
				console.error(`${MODULE_ID} | revert failed`, err);
				this.render();
			}
		});
	}

	static #onToggleAllies() {
		this.#collapse = !this.#collapse;
		this.render();
	}

	// --- canvas highlight -----------------------------------------------------------

	#hover(ev) {
		if (this.#stroke) {
			const cell = ev.target.closest?.("[data-cell]");
			if (cell) this.#paintCell(cell);
		}
		const el = ev.target.closest?.("[data-hl-o], [data-hl-t]");
		this.#highlight(el ? `${el.dataset.hlO ?? ""}|${el.dataset.hlT ?? ""}` : "");
	}

	#highlight(key) {
		if (key === this.#hl) return;
		this.#hl = key;
		if (!getSetting("matrix.highlight")) return;
		const [o, tg] = key.split("|");
		const items = [];
		if (o) items.push({ tokenId: o, role: "observer" });
		if (tg) items.push({ tokenId: tg, role: "target" });
		visuals.highlight(items);
	}
}

export function openMatrix() {
	if (!game.user.isGM) return null;
	instance ??= new MatrixApp();
	instance.render({ force: true });
	return instance;
}

function addTrackerButton(app, html) {
	if (!game.user.isGM) return;
	const nav = html.querySelector("header.combat-tracker-header nav.encounters");
	if (!nav || nav.querySelector(".pf2ev-open")) return;
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "inline-control icon fa-solid fa-table-cells pf2ev-open";
	btn.dataset.tooltip = t("matrix.open");
	btn.setAttribute("aria-label", t("matrix.open"));
	btn.addEventListener("click", () => openMatrix());
	nav.append(btn);
}

export function init() {
	Hooks.on("renderCombatTracker", addTrackerButton);
}

export function ready() {}
