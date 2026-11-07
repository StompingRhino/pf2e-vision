// Attack rolls (flat check, off-guard on hit) and off-guard on damage.
import { MODULE_ID, loc } from "./constants.mjs";
import { attackConsequences, flatMessageMode } from "./logic.mjs";
import { getConfig, getSetting } from "./settings.mjs";
import { getLevel, combatOf } from "./store.mjs";

const OFF_GUARD = "target:condition:off-guard";
const MARK = Symbol("pf2e-vision");
const warn = (where, err) => console.warn(`${MODULE_ID} | ${where}`, err);
const levelName = (level) => loc(`level.${level}`);
const doc = (t) => t?.document ?? t ?? null;

function sameCombat(a, b) {
	const combat = combatOf(a);
	return !!combat && combat === combatOf(b);
}

/** Attacker/target tokens in one combat -> consequences of the attack, otherwise null. */
function evaluate(attacker, target) {
	if (!attacker || !target || !sameCombat(attacker, target)) return null;
	const levelTA = getLevel(target.id, attacker.id, target.parent);
	const levelAT = getLevel(attacker.id, target.id, attacker.parent);
	const result = attackConsequences(levelTA, levelAT, getConfig(), {
		attackerIsPC: !!attacker.actor?.hasPlayerOwner,
		attackerOptions: attacker.actor?.getRollOptions?.() ?? [],
		targetOptions: target.actor?.getRollOptions?.() ?? []
	});
	return { ...result, levelTA, levelAT };
}

/** Attacker token of a strike/spell: checkContext of the attack message, else a token of the actor in the target's combat. */
function findAttacker(actor, target, checkContext) {
	const uuid = checkContext?.origin?.token;
	const fromContext = typeof uuid === "string" ? fromUuidSync(uuid) : null;
	if (fromContext) return fromContext;
	if (actor.token) return actor.token;
	const tokens = actor.getActiveTokens(true, true);
	return tokens.find((t) => sameCombat(t, target)) ?? tokens[0] ?? null;
}

const offGuardSource = (level) =>
	game.pf2e.ConditionManager.getCondition("off-guard", { name: loc("rolls.offGuardSource", { level: levelName(level) }) }).toObject();

function publish(roll, attacker, target, dc, passed, messageMode, note = "") {
	return roll.toMessage({
		speaker: ChatMessage.getSpeaker({ token: attacker }),
		flavor: loc(passed ? "rolls.flatPassChat" : "rolls.flatFailChat", {
			attacker: attacker.name, target: target.name, dc, total: roll.total
		}) + note
	}, { messageMode });
}

/** Mode of the flat-check message: the attack's messageMode (set by pf2e during Check.roll), Ctrl/Cmd secret roll, and flat.message. */
const flatMode = (context, setting, event) =>
	flatMessageMode(setting, context.messageMode ?? (event?.ctrlKey || event?.metaKey ? (game.user.isGM ? "gm" : "blind") : game.settings.get("core", "messageMode")));

async function checkRoll(wrapped, ...args) {
	const [, context] = args;
	let info, attacker, target;
	try {
		if (context?.type !== "attack-roll" || !context.target || context.isReroll || context.createMessage === false) return wrapped(...args);
		attacker = doc(context.origin?.token ?? context.token);
		target = doc(context.target.token);
		info = evaluate(attacker, target);
		if (!info) return wrapped(...args);

		context.options?.add(`${MODULE_ID}:target:${info.levelTA}`);
		context.options?.add(`${MODULE_ID}:origin:${info.levelAT}`);

		if (info.offGuard && !context.options?.has(OFF_GUARD)) {
			const actor = context.target.actor;
			const clone = actor.clone({ items: [...actor._source.items, offGuardSource(info.levelAT)] }, { keepId: true });
			context.target.actor = clone;
			const dc = context.dc?.slug ? clone.getStatistic(context.dc.slug)?.dc : null;
			if (dc) {
				context.dc.statistic = dc;
				context.dc.value = dc.value;
			}
			context.options?.add(OFF_GUARD);
		}
	} catch (err) {
		warn("checkRoll", err);
		return wrapped(...args);
	}

	if (info.flatDC == null) return wrapped(...args);

	// Rolled silently: the message is published only if the attack really happens.
	let roll;
	try {
		roll = await new Roll("1d20").evaluate();
	} catch (err) {
		warn("flatRoll", err);
		return wrapped(...args);
	}
	const passed = roll.total >= info.flatDC;
	if (!passed && info.onFail === "cancel") {
		// One message: the cancellation note goes into the flat check's flavor.
		try {
			await publish(roll, attacker, target, info.flatDC, false, flatMode(context, info.message, args[2]), `. ${loc("rolls.flatCancelled")}`);
		} catch (err) {
			warn("publish", err);
		}
		return null;
	}
	if (!passed && info.onFail === "miss") {
		const label = loc("rolls.flatLabel", { level: levelName(info.levelTA) });
		context.dosAdjustments = [
			...(context.dosAdjustments ?? []),
			{ adjustments: { success: { label, amount: "failure" }, criticalSuccess: { label, amount: "failure" } } }
		];
	}
	const result = await wrapped(...args);
	if (result !== null) {
		try {
			await publish(roll, attacker, target, info.flatDC, passed, flatMode(context, info.message, args[2]));
		} catch (err) {
			warn("publish", err);
		}
	}
	return result;
}

let casting = 0;

/** Spell card posted: targeted spells without an attack roll get a flat check per target. Variants re-enter toMessage, so only the outermost call checks. */
async function spellMessage(wrapped, event, options = {}, ...rest) {
	casting++;
	let message;
	try {
		message = await wrapped(event, options, ...rest);
	} finally {
		casting--;
	}
	if (casting || !message || options.create === false) return message;
	try {
		await spellFlatChecks(this, options.mode, event);
	} catch (err) {
		warn("spellFlat", err);
	}
	return message;
}

// ponytail: any posted spell card counts as a cast (pf2e has 4 spellcasting classes, all ending in toMessage); hook the casts if sharing cards mid-combat misfires.
async function spellFlatChecks(spell, mode, event) {
	if (!getSetting("flat.spells") || !spell.actor || spell.isAttack || spell.area || !spell.system.target?.value) return;
	for (const t of game.user.targets) {
		const target = t.document;
		const attacker = findAttacker(spell.actor, target, null);
		const info = evaluate(attacker, target);
		if (info?.flatDC == null) continue;
		const roll = await new Roll("1d20").evaluate();
		const passed = roll.total >= info.flatDC;
		const note = passed ? "" : `. ${loc("rolls.spellNoEffect", { spell: spell.name, target: target.name })}`;
		await publish(roll, attacker, target, info.flatDC, passed, flatMode({ messageMode: mode }, info.message, event), note);
	}
}

/** Strike damage/critical closures live in actor data; re-wrap them after every data preparation. */
function wrapStrikes(actor) {
	for (const strike of actor.system?.actions ?? []) {
		for (const s of [strike, ...(strike.altUsages ?? [])]) {
			for (const method of ["damage", "critical"]) {
				const orig = s[method];
				if (typeof orig !== "function" || orig[MARK]) continue;
				const wrapped = (params = {}) => orig(withOffGuard(actor, params));
				wrapped[MARK] = true;
				s[method] = wrapped;
			}
		}
	}
}

function withOffGuard(actor, params) {
	try {
		if (params.getFormula) return params;
		const target = doc(params.target ?? game.user.targets.first());
		const attacker = target && findAttacker(actor, target, params.checkContext);
		if (evaluate(attacker, target)?.offGuardDamage) return { ...params, options: new Set([...(params.options ?? []), OFF_GUARD]) };
	} catch (err) {
		warn("damage", err);
	}
	return params;
}

/** Spell attacks: getDamage ignores params.options, so give the spell's actor a temporary ephemeral off-guard effect on the target. */
async function spellDamage(wrapped, params, ...rest) {
	const actor = this.actor;
	let remove = null;
	try {
		const target = doc(params?.target);
		const attacker = target && this.isAttack && findAttacker(actor, target, null);
		const info = evaluate(attacker, target);
		if (info?.offGuardDamage) {
			const effect = () => offGuardSource(info.levelAT);
			const entry = (actor.synthetics.ephemeralEffects.damage ??= { origin: [], target: [] });
			(entry.target ??= []).push(effect);
			remove = () => {
				const i = entry.target.indexOf(effect);
				if (i >= 0) entry.target.splice(i, 1);
			};
		}
	} catch (err) {
		warn("spellDamage", err);
	}
	try {
		return await wrapped(params, ...rest);
	} finally {
		remove?.();
	}
}

export function init() {
	// CONFIG.PF2E exists by module init and actors are prepared after it, so no re-prepare is needed.
	for (const type of ["character", "npc", "hazard"]) {
		libWrapper.register(MODULE_ID, `CONFIG.PF2E.Actor.documentClasses.${type}.prototype.prepareData`, function (wrapped, ...args) {
			const result = wrapped(...args);
			try {
				wrapStrikes(this);
			} catch (err) {
				warn("wrapStrikes", err);
			}
			return result;
		}, "WRAPPER");
	}
	libWrapper.register(MODULE_ID, "CONFIG.PF2E.Item.documentClasses.spell.prototype.getDamage", spellDamage, "WRAPPER");
	libWrapper.register(MODULE_ID, "CONFIG.PF2E.Item.documentClasses.spell.prototype.toMessage", spellMessage, "WRAPPER");
}

export function ready() {
	// MIXED: flat.onFail = "cancel" returns null without calling the wrapped roll, which WRAPPER forbids.
	libWrapper.register(MODULE_ID, "game.pf2e.Check.roll", checkRoll, "MIXED");
}
