// Pure logic: no Foundry globals. Settings come in as `cfg` (object keyed by setting key).
import { LEVELS, DEFAULTS } from "./constants.mjs";

const val = (cfg, key) => cfg?.[key] ?? DEFAULTS[key];

export const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** Marker for "delete this key". The store swaps it for foundry.data.operators.ForcedDeletion. */
export const DEL = Object.freeze({ del: true });

export const rank = (level) => LEVELS.indexOf(level);
export const isOffGuardLevel = (level) => rank(level) >= rank("hidden");

/** Most visible level in the set (observed when empty). Unknown values are ignored. */
export function mostVisible(levels) {
	let best = "unnoticed";
	let any = false;
	for (const l of levels) {
		if (rank(l) < 0) continue;
		any = true;
		if (rank(l) < rank(best)) best = l;
	}
	return any ? best : "observed";
}

export function flatDC(level, cfg) {
	if (level === "concealed") return Number(val(cfg, "flat.dc.concealed"));
	if (level === "hidden") return Number(val(cfg, "flat.dc.hidden"));
	if (level === "undetected" || level === "unnoticed") return Number(val(cfg, "flat.dc.undetected"));
	return null;
}

/** flat.who: does the setting cover an attacker of this kind? */
export function flatApplies(cfg, attackerIsPC) {
	const who = val(cfg, "flat.who");
	return who === "all" || (who === "pc" ? !!attackerIsPC : !attackerIsPC);
}

/**
 * Consequences of `level` = how observer O sees target T.
 * - flatDC: flat check O makes when attacking T (null if none/disabled).
 * - offGuard: O is off-guard against T's attacks.
 * - offGuardDamage: same, but passed on to damage rolls.
 */
export function consequences(level, cfg) {
	const dc = flatDC(level, cfg);
	const off = isOffGuardLevel(level);
	return {
		flatDC: val(cfg, "flat.enabled") ? dc : null,
		offGuard: !!val(cfg, "offguard.attack") && off,
		offGuardDamage: !!val(cfg, "offguard.damage") && off
	};
}

/**
 * Feats that change the attacker's flat check (pf2e roll options of the attacker). Value per level: number = DC cap, null = no flat check.
 * noOffGuard: levels at which the owner is not off-guard to an unseen attacker. Only unconditional feats; ponytail: Supernatural Senses
 * (while raging), Revealing Stab (one Strike), Thousand Visions (range) are left out — add with a predicate when needed.
 */
export const SENSE_FEATS = [
	{ options: ["feature:keen-eyes", "feat:keen-eyes"], flat: { concealed: 3, hidden: 9 } },
	{ options: ["feat:blind-fight"], flat: { concealed: null, hidden: 5 }, noOffGuard: ["hidden"] }
];
const featsOf = (options) => {
	const set = new Set(options ?? []);
	return SENSE_FEATS.filter((f) => f.options.some((o) => set.has(o)));
};

/** Flat DC after the attacker's feats: the lowest wins, null (no check) beats any number. A feat never raises the world setting. */
export function adjustFlatDC(dc, level, attackerOptions) {
	if (dc == null) return null;
	let out = dc;
	for (const f of featsOf(attackerOptions)) {
		if (!(level in f.flat)) continue;
		const v = f.flat[level];
		if (v === null) return null;
		out = Math.min(out, v);
	}
	return out;
}

/**
 * Attack of A against T.
 * @param levelTA getLevel(T, A): how A sees T -> flat check done by A.
 * @param levelAT getLevel(A, T): how T sees A -> T is off-guard when A is hidden from T.
 * attackerOptions / targetOptions: pf2e roll options of the actors (SENSE_FEATS).
 */
export function attackConsequences(levelTA, levelAT, cfg, { attackerIsPC, attackerOptions = [], targetOptions = [] }) {
	const flat = adjustFlatDC(consequences(levelTA, cfg).flatDC, levelTA, attackerOptions);
	const off = consequences(levelAT, cfg);
	const useFlat = flat != null && flatApplies(cfg, attackerIsPC);
	const immune = featsOf(targetOptions).some((f) => f.noOffGuard?.includes(levelAT));
	return {
		flatDC: useFlat ? flat : null,
		onFail: val(cfg, "flat.onFail"),
		message: val(cfg, "flat.message"),
		offGuard: off.offGuard && !immune,
		offGuardDamage: off.offGuardDamage && !immune
	};
}

/** Seek is a perception check in pf2e, Hide/Sneak are skill checks. Returns "hide" | "sneak" | "seek" | null. */
export function recognizeAction(ctx, actions = ["hide", "sneak", "seek"]) {
	if (ctx?.type !== "skill-check" && ctx?.type !== "perception-check") return null;
	return actions.find((a) => ctx.options?.includes(`action:${a}`)) ?? null;
}

/** Chat message mode of the flat-check message. `mode` = the attack's messageMode (public/gm/blind/self); blind stays blind. */
export function flatMessageMode(setting, mode) {
	if (mode === "blind") return "blind";
	return setting === "gm" || mode === "gm" || mode === "self" ? "gm" : "public";
}

/** Token alpha factor a player sees for `level` (undefined = unchanged). cfg: visual.* settings. */
export function opacityFactor(level, cfg) {
	if (level === "concealed") return val(cfg, "visual.concealedOpacity");
	if (level === "hidden" || (rank(level) >= rank("undetected") && !val(cfg, "visual.hideUndetected"))) return val(cfg, "visual.hiddenOpacity");
	return undefined;
}

/** Per-action automation mode: off / suggest / auto. */
export function actionMode(action, cfg) {
	const mode = val(cfg, `auto.${action}`);
	return mode === "auto" || mode === "suggest" ? mode : "off";
}

/** Same side by the chosen criterion. a/b: { alliance, hasPlayerOwner }. */
export function sameSide(a, b, criterion) {
	if (criterion === "owner") return !!a.hasPlayerOwner === !!b.hasPlayerOwner;
	return (a.alliance ?? null) === (b.alliance ?? null);
}

/** Observers for Hide/Sneak by `auto.observers`: enemies are always judged by alliance. */
export function selectObservers(hider, others, cfg) {
	if (val(cfg, "auto.observers") === "all") return others;
	return others.filter((o) => !sameSide(hider, o, "alliance"));
}

/** Degree of success: +-10 from the DC, nat 20 / nat 1 shift one step. */
export function degreeOfSuccess(total, dc, natural) {
	let i = total >= dc + 10 ? 3 : total >= dc ? 2 : total > dc - 10 ? 1 : 0;
	if (natural === 20) i = Math.min(3, i + 1);
	else if (natural === 1) i = Math.max(0, i - 1);
	return DEGREES[i];
}

/** New level of the target for one observer after Hide / Sneak / Seek. Unnoticed behaves as undetected. */
export function transition(action, level, degree) {
	const win = degree === "success" || degree === "criticalSuccess";
	const secret = isOffGuardLevel(level);
	if (action === "hide") return !secret && win ? "hidden" : level;
	if (action === "sneak") {
		if (!secret) return level;
		if (win) return "undetected";
		return degree === "criticalFailure" ? "observed" : "hidden";
	}
	if (action === "seek") {
		if (!secret || !win) return level;
		if (degree === "criticalSuccess") return "observed";
		return level === "hidden" ? "observed" : "hidden";
	}
	return level;
}

/**
 * Build the token updates for a batch of changes.
 * @param getLevel (targetId, observerId) => level
 * @param changes [{observerId, targetId, level}] (last one wins per cell)
 * @param flagPath [scope, key] of the flag
 * @returns {{updates, reverse}} updates for scene.updateEmbeddedDocuments("Token", ...);
 *   reverse = changes that restore the previous levels (only cells that really change).
 */
export function buildDiff(getLevel, changes, flagPath = ["pf2e-vision", "visibility"], del = DEL) {
	const cells = new Map();
	for (const c of changes) cells.set(`${c.targetId}\u0000${c.observerId}`, c);
	const byTarget = new Map();
	const reverse = [];
	for (const c of cells.values()) {
		const before = getLevel(c.targetId, c.observerId) ?? "observed";
		if (before === c.level) continue;
		reverse.push({ observerId: c.observerId, targetId: c.targetId, level: before });
		const entry = byTarget.get(c.targetId) ?? {};
		entry[c.observerId] = c.level === "observed" ? del : c.level;
		byTarget.set(c.targetId, entry);
	}
	const [scope, key] = flagPath;
	const updates = [...byTarget].map(([_id, vis]) => ({ _id, flags: { [scope]: { [key]: vis } } }));
	return { updates, reverse };
}

/**
 * Which combat the module treats as "the" combat on `sceneId`: the active one, else a started one with
 * participants on that scene (the viewed one preferred). Candidates come only from `contents`, so a
 * just-deleted combat that `viewed` still points at is ignored; an unstarted viewed draft is never picked.
 * `combats` = game.combats-like {active, viewed, contents}.
 */
export function pickCombat(combats, sceneId) {
	if (combats?.active) return combats.active;
	const ok = (combats?.contents ?? []).filter((c) => c.started && (!sceneId || c.combatants.some((p) => p.sceneId === sceneId)));
	return ok.find((c) => c === combats.viewed) ?? ok[0] ?? null;
}
