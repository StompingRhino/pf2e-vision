import { MODULE_ID, LOC, loc as t, LEVELS, levelChip } from "./constants.mjs";
import { confirmRows, pickChanges } from "./logic.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Confirmation window for a Hide / Sneak / Seek suggestion. `onApply(edits, changes)` gets [{apply, level}] per row. */
export class ConfirmApp extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		classes: [MODULE_ID, "pf2ev-app"],
		position: { width: 600, height: "auto" },
		window: { title: `${LOC}.suggest.windowTitle`, icon: "fa-solid fa-eye", resizable: true },
		actions: { apply: ConfirmApp.#onApply, cancel: ConfirmApp.#onCancel }
	};

	static PARTS = { main: { template: `modules/${MODULE_ID}/templates/confirm.hbs` } };

	constructor({ title, rows, onApply }) {
		super({ id: `${MODULE_ID}-confirm-${foundry.utils.randomID(6)}` });
		this.heading = title;
		this.rows = confirmRows(rows);
		this.onApply = onApply;
	}

	async _prepareContext() {
		const L = Object.fromEntries(["observer", "dc", "degree", "was", "becomes", "apply", "cancel", "include"].map((k) => [k, t(`suggest.${k}`)]));
		return {
			L, title: this.heading,
			rows: this.rows.map((r, i) => ({
				...r, i,
				initial: [...(r.name || "?")][0].toUpperCase(),
				degreeKey: r.degree, degree: t(`degree.${r.degree}`),
				was: { ...levelChip(r.was), name: t(`level.${r.was}`), short: t(`levelShort.${r.was}`) },
				levels: LEVELS.map((l) => ({ ...levelChip(l), name: t(`level.${l}`), on: l === r.level }))
			}))
		};
	}

	/** Picking a level other than «was» ticks the row: the GM's edit is the intent to apply it. */
	_onRender(context, options) {
		super._onRender?.(context, options);
		this.element.querySelectorAll(".pf2ev-pick input").forEach((input) => input.addEventListener("change", () => {
			const i = Number(input.dataset.i), box = this.element.querySelector(`[name=apply-${i}]`);
			if (box) box.checked = input.value !== this.rows[i].was;
		}));
	}

	static async #onApply() {
		const edits = this.rows.map((r, i) => ({
			apply: this.element.querySelector(`[name=apply-${i}]`).checked,
			level: this.element.querySelector(`[name=level-${i}]:checked`)?.value ?? r.level
		}));
		await this.onApply(edits, pickChanges(this.rows, edits));
		this.close();
	}

	static #onCancel() {
		this.close();
	}
}
