export const MODULE_ID = "pf2e-vision";
export const FLAG_KEY = "visibility";
export const LOC = "PF2EVISION";

/** Localise PF2EVISION.<key>, with optional {placeholders}. */
export const loc = (key, data) => game.i18n.format(`${LOC}.${key}`, data);

/** Most visible first. Index = rank. */
export const LEVELS = ["observed", "concealed", "hidden", "undetected", "unnoticed"];

export const LEVEL_COLORS = {
	observed: "#e6dccb",   // обычное состояние — тихая бумага на пергаменте, цветом выделяются только отклонения
	concealed: "#8fb8d4",
	hidden: "#e3a23b",
	undetected: "#b8483a",
	unnoticed: "#5a3d8c"
};

export const LEVEL_ICONS = Object.fromEntries(
	LEVELS.map((l) => [l, `systems/pf2e/icons/conditions/${l}.webp`])
);

/** Readable text colour on a level colour (matrix brushes and cells, confirm window and card chips). */
export const fgFor = (hex) => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#1b1406" : "#f4efe4";
};

/** Level chip data for templates: colour, text colour, pf2e condition icon. */
export const levelChip = (level) => ({ level, color: LEVEL_COLORS[level], fg: fgFor(LEVEL_COLORS[level]), icon: LEVEL_ICONS[level] });

export const MODES = ["off", "suggest", "auto"];

/**
 * Every setting of the module. `menu: true` -> edited only in the "Automation" window.
 * `choices` -> String setting; keys are localised via PF2EVISION.settings.choice.<value>.
 */
export const SETTINGS = [
	{ key: "auto.hide", scope: "world", menu: true, default: "suggest", choices: MODES },
	{ key: "auto.sneak", scope: "world", menu: true, default: "suggest", choices: MODES },
	{ key: "auto.seek", scope: "world", menu: true, default: "suggest", choices: MODES },
	{ key: "auto.observers", scope: "world", menu: true, default: "enemies", choices: ["enemies", "all"] },
	{ key: "flat.enabled", scope: "world", menu: true, default: true },
	{ key: "flat.dc.concealed", scope: "world", menu: true, default: 5 },
	{ key: "flat.dc.hidden", scope: "world", menu: true, default: 11 },
	{ key: "flat.dc.undetected", scope: "world", menu: true, default: 11 },
	{ key: "flat.onFail", scope: "world", menu: true, default: "miss", choices: ["miss", "warn", "cancel"] },
	{ key: "flat.who", scope: "world", menu: true, default: "all", choices: ["all", "pc", "npc"] },
	{ key: "flat.message", scope: "world", menu: true, default: "public", choices: ["public", "gm"] },
	{ key: "flat.spells", scope: "world", menu: true, default: true },
	{ key: "offguard.attack", scope: "world", menu: true, default: true },
	{ key: "offguard.damage", scope: "world", menu: true, default: true },
	{ key: "cleanup.onCombatEnd", scope: "world", menu: true, default: true },

	{ key: "visual.concealedOpacity", scope: "world", default: 0.8, range: { min: 0, max: 1, step: 0.05 } },
	{ key: "visual.hiddenOpacity", scope: "world", default: 0.45, range: { min: 0, max: 1, step: 0.05 } },
	{ key: "visual.hideUndetected", scope: "world", default: true },
	{ key: "visual.hideInTracker", scope: "world", default: false },
	{ key: "visual.badge", scope: "world", default: true },

	{ key: "visual.gmIndicators", scope: "client", default: true },
	{ key: "matrix.collapseAllies", scope: "client", default: false },
	{ key: "matrix.allyCriterion", scope: "client", default: "alliance", choices: ["alliance", "owner"] },
	{ key: "matrix.hotkeys", scope: "client", default: true },
	{ key: "matrix.tooltip", scope: "client", default: true },
	{ key: "matrix.highlight", scope: "client", default: true }
];

export const DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
