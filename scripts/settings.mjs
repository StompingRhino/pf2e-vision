import { MODULE_ID, LOC, SETTINGS } from "./constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const typeOf = (def) =>
	def.choices ? String : typeof def.default === "boolean" ? Boolean : Number;

/** The only place that reads module settings. */
export function getSetting(key) {
	return game.settings.get(MODULE_ID, key);
}

/** Snapshot of all settings as a plain object for logic.mjs. */
export function getConfig() {
	return Object.fromEntries(SETTINGS.map((s) => [s.key, getSetting(s.key)]));
}

const MENU_DEFS = SETTINGS.filter((s) => s.menu);

class AutomationMenu extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: `${MODULE_ID}-automation`,
		tag: "form",
		classes: [MODULE_ID, "pf2ev-app", "pf2e-vision-settings"],
		position: { width: 520 },
		window: { title: `${LOC}.settings.menu.name`, icon: "fa-solid fa-eye-slash", contentClasses: ["standard-form"] },
		form: { handler: AutomationMenu.#onSubmit, closeOnSubmit: true }
	};

	static PARTS = {
		form: { template: `modules/${MODULE_ID}/templates/settings-menu.hbs` }
	};

	async _prepareContext() {
		const groups = [];
		for (const def of MENU_DEFS) {
			const prefix = def.key.split(".")[0];
			let group = groups.find((g) => g.prefix === prefix);
			if (!group) groups.push((group = { prefix, title: game.i18n.localize(`${LOC}.settings.group.${prefix}`), fields: [] }));
			const value = getSetting(def.key);
			group.fields.push({
				name: def.key,
				label: game.i18n.localize(`${LOC}.settings.${def.key}.name`),
				hint: game.i18n.localize(`${LOC}.settings.${def.key}.hint`),
				value,
				isCheckbox: typeof def.default === "boolean",
				isNumber: typeof def.default === "number",
				isSelect: !!def.choices,
				choices: def.choices?.map((c) => ({
					value: c,
					label: game.i18n.localize(`${LOC}.settings.choice.${c}`),
					selected: c === value
				}))
			});
		}
		return { groups };
	}

	static async #onSubmit(event, form, formData) {
		// spike: formData.object keyed by the raw input name (dotted names kept flat)
		const data = formData.object;
		for (const def of MENU_DEFS) {
			if (!(def.key in data)) continue;
			const raw = data[def.key];
			const value = typeof def.default === "number" ? Number(raw) : raw;
			if (typeof value === "number" && Number.isNaN(value)) continue;
			if (value !== getSetting(def.key)) await game.settings.set(MODULE_ID, def.key, value);
		}
	}
}

export function registerSettings() {
	for (const def of SETTINGS) {
		game.settings.register(MODULE_ID, def.key, {
			name: `${LOC}.settings.${def.key}.name`,
			hint: `${LOC}.settings.${def.key}.hint`,
			scope: def.scope,
			config: !def.menu,
			type: typeOf(def),
			default: def.default,
			range: def.range,
			choices: def.choices && Object.fromEntries(def.choices.map((c) => [c, `${LOC}.settings.choice.${c}`])),
			onChange: (value) => Hooks.callAll(`${MODULE_ID}.setting`, def.key, value)
		});
	}
	game.settings.registerMenu(MODULE_ID, "automation", {
		name: `${LOC}.settings.menu.name`,
		label: `${LOC}.settings.menu.label`,
		hint: `${LOC}.settings.menu.hint`,
		icon: "fa-solid fa-eye-slash",
		type: AutomationMenu,
		restricted: true
	});
}
