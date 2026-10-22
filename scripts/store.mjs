// Visibility storage (PLAN 1.7): flags.pf2e-vision.visibility = {[observerTokenId]: level} on the TARGET token.
// observed = key absent. Levels are read straight from the token documents (no cache: it is a plain property read).
import { MODULE_ID, FLAG_KEY } from "./constants.mjs";
import { buildDiff, DEL, pickCombat } from "./logic.mjs";
import { getSetting } from "./settings.mjs";

const listeners = new Set();
const notify = foundry.utils.debounce(() => {
	for (const fn of listeners) {
		try { fn(); } catch (e) { console.error(`${MODULE_ID} | onChange listener`, e); }
	}
}, 50);

const forcedDeletion = () => globalThis._del ?? new foundry.data.operators.ForcedDeletion();
// Swap the DEL marker for the real operator in the update payload.
const withDeletes = (v) => v === DEL ? forcedDeletion()
	: (v && typeof v === "object") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withDeletes(x)])) : v;

export function init() {}

export function ready() {
	const ours = (changes) => !!changes?.flags && MODULE_ID in changes.flags;
	Hooks.on("updateToken", (_doc, changes) => { if (ours(changes)) notify(); });
	for (const h of ["createToken", "deleteToken", "canvasReady", "createCombatant", "updateCombatant", "updateCombat"]) {
		Hooks.on(h, notify);
	}
	Hooks.on("deleteCombatant", (combatant) => {
		notify();
		cleanup(combatant.sceneId, [combatant.tokenId], true);
	});
	Hooks.on("deleteCombat", (combat) => {
		notify();
		const bySceneId = new Map();
		for (const c of combat.combatants) {
			if (c.tokenId && c.sceneId) (bySceneId.get(c.sceneId) ?? bySceneId.set(c.sceneId, []).get(c.sceneId)).push(c.tokenId);
		}
		for (const [sceneId, ids] of bySceneId) cleanup(sceneId, ids);
	});
}

const pick = (sceneId = canvas?.scene?.id ?? game.scenes?.current?.id) => pickCombat(game.combats, sceneId);

/**
 * The combat (see pickCombat) if `tokenDoc` is a participant of it (same tokenId and sceneId), else null.
 * Not `tokenDoc.combatant`: that follows game.combat (the viewed combat), not the active one.
 */
export function combatOf(tokenDoc) {
	const sceneId = tokenDoc?.parent?.id;
	const combat = sceneId && pick(sceneId);
	return combat && sceneId && combat.combatants.some((c) => c.tokenId === tokenDoc.id && c.sceneId === sceneId) ? combat : null;
}

/** Scene of the picked combat's participants (first one), else the viewed scene. */
export function combatScene() {
	for (const c of pick()?.combatants ?? []) {
		const scene = c.sceneId && game.scenes.get(c.sceneId);
		if (scene) return scene;
	}
	return canvas.scene;
}

/** How `observerTokenId` sees `targetTokenId` on `scene` (default: combatScene()). */
export function getLevel(targetTokenId, observerTokenId, scene = combatScene()) {
	const tok = scene?.tokens.get(targetTokenId);
	return tok?.getFlag(MODULE_ID, FLAG_KEY)?.[observerTokenId] ?? "observed";
}

/** TokenDocuments of the active combat's participants on `scene` (default: combatScene()). */
export function getCombatTokens(scene = combatScene()) {
	return (pick(scene?.id)?.combatants ?? [])
		.filter((c) => c.sceneId === scene?.id)
		.map((c) => c.tokenId && scene.tokens.get(c.tokenId))
		.filter(Boolean);
}

/** @param changes [{observerId, targetId, level}] -> reverse diff (logic.buildDiff().reverse) */
export async function applyChanges(changes, scene = combatScene()) {
	if (!game.user.isGM || !scene) return [];
	const { updates, reverse } = buildDiff((t, o) => getLevel(t, o, scene), changes);
	if (updates.length) await scene.updateEmbeddedDocuments("Token", updates.map(withDeletes));
	return reverse;
}

export async function revert(diff, scene) {
	if (diff?.length) await applyChanges(diff, scene);
}

/** Subscribe to visibility changes. Returns an unsubscribe function. */
export function onChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Only the active GM's client, if cleanup.onCombatEnd. Wipes the flag on the tokens `tokenIds`
 * and (`dropObserver`) their entries as observers on the other tokens of the scene.
 */
async function cleanup(sceneId, tokenIds, dropObserver = false) {
	if (!game.user.isActiveGM || !getSetting("cleanup.onCombatEnd")) return;
	const scene = game.scenes.get(sceneId);
	if (!scene) return;
	// A token that is still fighting in the active combat keeps its levels.
	const active = pick(sceneId)?.combatants;
	const gone = new Set(tokenIds.filter((id) => !active?.some((c) => c.tokenId === id && c.sceneId === sceneId)));
	if (!gone.size) return;
	const updates = [];
	for (const tok of scene.tokens) {
		const flag = tok.getFlag(MODULE_ID, FLAG_KEY);
		if (!flag) continue;
		if (gone.has(tok.id)) updates.push({ _id: tok.id, flags: { [MODULE_ID]: { [FLAG_KEY]: forcedDeletion() } } });
		else if (dropObserver) {
			const stale = Object.keys(flag).filter((o) => gone.has(o));
			if (stale.length) updates.push({ _id: tok.id, flags: { [MODULE_ID]: { [FLAG_KEY]: Object.fromEntries(stale.map((o) => [o, forcedDeletion()])) } } });
		}
	}
	if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);
}
