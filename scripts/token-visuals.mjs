import { MODULE_ID, LEVEL_ICONS } from "./constants.mjs";
import { mostVisible, rank, opacityFactor } from "./logic.mjs";
import { getSetting } from "./settings.mjs";
import * as store from "./store.mjs";

const HIGHLIGHT_COLORS = { observer: 0x8fb8d4, target: 0xffd54a };
const BADGE = "pf2eVisionBadge";

let graphics = null;

// Setting values cached (keyed like the settings): the wrappers run per token per frame.
const KEYS = ["visual.concealedOpacity", "visual.hiddenOpacity", "visual.hideUndetected", "visual.hideInTracker", "visual.badge", "visual.gmIndicators"];
const V = {};

/** Most visible level of TokenDocument `doc` over the observer TokenDocuments; only tokens of the active combat count. */
function levelFrom(doc, observers) {
	const mine = observers.filter((o) => o.id !== doc.id && store.combatOf(o));
	return mine.length ? mostVisible(mine.map((o) => store.getLevel(doc.id, o.id, doc.parent))) : "observed";
}

/** Level at which a player sees TokenDocument `doc`: relative to their own tokens on its scene. */
const playerLevel = (doc) =>
	doc.isOwner || !store.combatOf(doc) ? "observed" : levelFrom(doc, doc.parent.tokens.filter((o) => o.isOwner));

/** Level at which the current user sees `token`; "observed" when nothing applies. */
function effectiveLevel(token) {
	if (!canvas.ready || token.controlled) return "observed";
	if (!game.user.isGM) return playerLevel(token.document);
	if (!V["visual.gmIndicators"] || !store.combatOf(token.document)) return "observed";
	return levelFrom(token.document, canvas.tokens.controlled.map((t) => t.document));
}

const isUndetected = (level) => rank(level) >= rank("undetected");
const isHiddenFromPlayer = (token) => !game.user.isGM && V["visual.hideUndetected"] && isUndetected(effectiveLevel(token));

async function setBadge(token, level) {
	const find = () => token.children.find((c) => c.name === BADGE);
	const want = level && level !== "observed" ? level : null;
	token._pf2eVisionBadge = want;
	const old = find();
	if (!want) return void old?.destroy();
	if (old?.pvLevel === want) return;
	old?.destroy();
	const tex = await foundry.canvas.loadTexture(LEVEL_ICONS[want]);
	// Texture load is async: bail if the token died or the wanted level changed meanwhile.
	if (token.destroyed || token._pf2eVisionBadge !== want) return;
	find()?.destroy();
	const b = new PIXI.Sprite(tex);
	b.name = BADGE;
	b.pvLevel = want;
	b.width = b.height = Math.max(20, token.h / 3);
	b.position.set(token.w - b.width, 0);
	token.addChild(b);
}

function onRefreshToken(token) {
	if (!canvas.ready) return;
	const level = effectiveLevel(token);
	setBadge(token, V["visual.badge"] || game.user.isGM ? level : null);
	if (game.user.isGM || !token.mesh) return;
	const factor = opacityFactor(level, V);
	if (factor !== undefined) token.mesh.alpha = Math.min(token.mesh.alpha, token.document.alpha * factor);
}

export function refreshAll() {
	for (const t of canvas.tokens?.placeables ?? []) t.renderFlags.set({ refreshVisibility: true, refreshState: true });
}

const refreshSoon = foundry.utils.debounce(refreshAll, 50);

/** @param items [{tokenId, role: "observer" | "target"}] ; empty array clears. */
export function highlight(items) {
	graphics?.destroy();
	graphics = null;
	if (!items?.length || !canvas.ready || !getSetting("matrix.highlight")) return;
	const g = new PIXI.Graphics();
	for (const { tokenId, role } of items) {
		const t = canvas.tokens.get(tokenId);
		if (!t) continue;
		g.lineStyle(5, HIGHLIGHT_COLORS[role] ?? HIGHLIGHT_COLORS.target, 1).drawRect(t.x, t.y, t.w, t.h);
	}
	canvas.interface.addChild(g);
	graphics = g;
}

export function init() {
	libWrapper.register(
		MODULE_ID,
		"CONFIG.Token.objectClass.prototype.isVisible",
		function (wrapped) {
			return wrapped() && !isHiddenFromPlayer(this);
		},
		"WRAPPER"
	);
	// The combat tracker skips combatants that are not visible.
	libWrapper.register(
		MODULE_ID,
		"CONFIG.Combatant.documentClass.prototype.visible",
		function (wrapped) {
			return wrapped() && !(V["visual.hideInTracker"] && !game.user.isGM && this.token && isUndetected(playerLevel(this.token)));
		},
		"WRAPPER"
	);
}

const renderTracker = foundry.utils.debounce(() => {
	if (V["visual.hideInTracker"] && !game.user.isGM) ui.combat?.render();
}, 50);

export function ready() {
	for (const k of KEYS) V[k] = getSetting(k);
	Hooks.on("pf2e-vision.setting", (key, value) => {
		if (!KEYS.includes(key)) return;
		V[key] = value;
		refreshAll();
		if (key === "visual.hideInTracker" && !game.user.isGM) ui.combat?.render();
	});
	Hooks.on("refreshToken", onRefreshToken);
	Hooks.on("controlToken", refreshSoon);
	Hooks.on("createToken", refreshSoon);
	Hooks.on("deleteToken", refreshSoon);
	// combat membership changes which tokens count as observers
	for (const h of ["createCombatant", "deleteCombatant", "updateCombatant", "deleteCombat"]) Hooks.on(h, refreshSoon);
	Hooks.on("canvasReady", () => {
		graphics = null; // destroyed with the old canvas
		refreshAll();
	});
	store.onChange(refreshSoon);
	store.onChange(renderTracker);
	if (canvas.ready) refreshAll();
}
