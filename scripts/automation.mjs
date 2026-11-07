import { MODULE_ID, loc, levelChip } from "./constants.mjs";
import { getConfig } from "./settings.mjs";
import { actionMode, degreeOfSuccess, transition, selectObservers, isOffGuardLevel, recognizeAction } from "./logic.mjs";
import * as store from "./store.mjs";
import { ConfirmApp } from "./confirm-app.mjs";


export function init() {}

export function ready() {
	Hooks.on("createChatMessage", onCreate);
	Hooks.on("renderChatMessageHTML", onRender);
}

function recognise(message) {
	const ctx = message.flags?.pf2e?.context;
	const action = recognizeAction(ctx);
	return action ? { action, ctx } : null;
}

function natural(message, ctx) {
	for (const o of ctx.contextualOptions?.postRoll ?? []) {
		const m = /^check:roll:total:natural:(\d+)$/.exec(o);
		if (m) return Number(m[1]);
	}
	return message.rolls[0]?.dice?.[0]?.total; // fallback if the option is absent
}

/** Participants of the active combat that sit on `scene`. */
function participants(combat, scene) {
	return combat.combatants.contents
		.filter((c) => c.sceneId === scene.id && c.actor && scene.tokens.get(c.tokenId))
		.map((c) => {
			const tok = scene.tokens.get(c.tokenId);
			return { tok, actor: c.actor, id: tok.id, alliance: c.actor.alliance, hasPlayerOwner: c.actor.hasPlayerOwner };
		});
}

async function seekTargetIds(message, ctx) {
	const ids = new Set();
	const add = (t) => t && ids.add(t.document?.id ?? t.id);
	message.author?.targets?.forEach(add);
	const uuid = ctx.target?.token;
	if (uuid) add(await fromUuid(uuid));
	try {
		(await game.toolbelt?.api?.targetHelper?.getMessageTargets?.(message))?.forEach(add);
	} catch (e) {
		console.warn(`${MODULE_ID} | target-helper`, e);
	}
	ids.delete(undefined);
	return ids;
}

async function onCreate(message) {
	if (game.user !== game.users.activeGM) return;
	const rec = recognise(message);
	if (!rec) return;
	const { action, ctx } = rec;
	const cfg = getConfig();
	const mode = actionMode(action, cfg);
	if (mode === "off") return;

	const total = message.rolls[0]?.total;
	const scene = game.scenes.get(message.speaker.scene);
	const actorTok = scene?.tokens.get(ctx.token ?? message.speaker.token);
	const combat = actorTok && store.combatOf(actorTok);
	if (total == null || !combat) return;
	const nat = natural(message, ctx);
	const all = participants(combat, scene);
	const me = all.find((p) => p.id === actorTok.id);
	if (!me) return;
	const others = all.filter((p) => p !== me);

	const rows = [];
	const push = (obs, tgt, dc) => {
		if (dc == null) return;
		const was = store.getLevel(tgt.id, obs.id, scene);
		const degree = degreeOfSuccess(total, dc, nat);
		const becomes = transition(action, was, degree);
		const who = action === "seek" ? tgt : obs;   // строка называет того, кто в ней меняется для ГМа: наблюдателя (у Поиска — цель)
		rows.push({ observerId: obs.id, targetId: tgt.id, name: who.tok.name, side: who.hasPlayerOwner ? "pc" : "npc", dc, degree, was, becomes });
	};
	let note = "";
	if (action === "seek") {
		const ids = await seekTargetIds(message, ctx);
		// explicit targets: only them; none: everyone hidden from the seeker
		let targets;
		if (ids.size) {
			targets = others.filter((p) => ids.has(p.id));
			if (!targets.length) note = loc("suggest.noTargets");
		} else {
			targets = others.filter((p) => isOffGuardLevel(store.getLevel(p.id, me.id, scene)));
		}
		for (const t of targets) push(me, t, t.actor.skills?.stealth?.dc?.value);
	} else {
		for (const o of selectObservers(me, others, cfg)) push(o, me, o.actor.perception?.dc?.value);
	}

	const actionName = loc(`action.${action}`);
	const title = loc("suggest.title", { actor: actorTok.name, action: actionName });
	if (mode === "auto") {
		const changed = rows.filter((r) => r.becomes !== r.was);
		if (!changed.length) return;
		await store.applyChanges(changed.map(({ observerId, targetId, becomes }) => ({ observerId, targetId, level: becomes })), scene);
		return ChatMessage.create({
			content: `<div class="pf2ev-sheet"><header class="pf2ev-card-head"><i class="fa-solid fa-eye" aria-hidden="true"></i><span>${foundry.utils.escapeHTML(loc("suggest.autoTitle"))}</span></header><div class="pf2ev-note"><p>${foundry.utils.escapeHTML(loc("suggest.autoSummary", { action: actionName, actor: actorTok.name, count: changed.length }))}</p></div></div>`,
			whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
			speaker: { alias: "PF2e Vision" }
		});
	}
	if (!rows.length && !note) return;
	const data = { title, note, rows, applied: false, sceneId: scene.id };
	const card = await ChatMessage.create({
		content: await renderCard(data),
		whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
		speaker: { alias: "PF2e Vision" },
		flags: { [MODULE_ID]: { suggest: data } }
	});
	if (rows.length) openWindow(card);
	return card;
}

function renderCard(data) {
	const L = Object.fromEntries(["observer", "dc", "degree", "was", "becomes", "open", "noChanges"].map((k) => [k, loc(`suggest.${k}`)]));
	const lv = (l) => loc(`level.${l}`);
	const shown = data.rows.filter((r) => r.becomes !== r.was);   // запись в чате — только изменения; все пары видны в окне
	return foundry.applications.handlebars.renderTemplate(`modules/${MODULE_ID}/templates/suggest.hbs`, {
		...data,
		L,
		intro: loc("suggest.intro"),
		appliedText: loc("suggest.applied", { count: shown.length }),
		shown: shown.map((r) => ({
			...r, degreeKey: r.degree, degree: loc(`degree.${r.degree}`),
			was: { ...levelChip(r.was), name: lv(r.was) }, becomes: { ...levelChip(r.becomes), name: lv(r.becomes) }
		}))
	});
}

/** The only way to apply: the confirmation window. The card is the record. */
function openWindow(message) {
	const data = message.flags?.[MODULE_ID]?.suggest;
	if (!data || data.applied || !game.user.isGM) return;
	new ConfirmApp({
		title: data.title,
		rows: data.rows,
		onApply: async (edits, changes) => {
			try {
				await store.applyChanges(changes, game.scenes.get(data.sceneId));
			} catch (e) {
				console.error(`${MODULE_ID} |`, e);
				ui.notifications.error(loc("notify.applyFailed"));
				throw e;
			}
			const key = (c) => `${c.observerId}|${c.targetId}`;
			const lv = new Map(changes.map((c) => [key(c), c.level]));
			const rows = data.rows.filter((r) => lv.has(key(r))).map((r) => ({ ...r, becomes: lv.get(key(r)) }));
			const next = { ...data, applied: true, rows };
			await message.update({ content: await renderCard(next), [`flags.${MODULE_ID}.suggest`]: next });
		}
	}).render({ force: true });
}

function onRender(message, html) {
	const data = message.flags?.[MODULE_ID]?.suggest;
	if (!data || data.applied) return;
	html.querySelector?.("[data-action=open]")?.addEventListener("click", () => openWindow(message));
}
