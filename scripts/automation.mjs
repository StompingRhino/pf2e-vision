import { MODULE_ID, loc } from "./constants.mjs";
import { getConfig } from "./settings.mjs";
import { actionMode, degreeOfSuccess, transition, selectObservers, isOffGuardLevel, recognizeAction } from "./logic.mjs";
import * as store from "./store.mjs";


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
		if (becomes !== was) rows.push({ observerId: obs.id, targetId: tgt.id, name: (action === "seek" ? tgt : obs).tok.name, dc, degree, was, becomes });
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
		if (!rows.length) return;
		await store.applyChanges(rows.map(({ observerId, targetId, becomes }) => ({ observerId, targetId, level: becomes })), scene);
		return ChatMessage.create({
			content: `<p>${foundry.utils.escapeHTML(loc("suggest.autoSummary", { action: actionName, actor: actorTok.name, count: rows.length }))}</p>`,
			whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
			speaker: { alias: "PF2e Vision" }
		});
	}
	if (!rows.length && !note) return;
	const data = { title, note, rows, applied: false, sceneId: scene.id };
	return ChatMessage.create({
		content: await renderCard(data),
		whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
		speaker: { alias: "PF2e Vision" },
		flags: { [MODULE_ID]: { suggest: data } }
	});
}

function renderCard(data) {
	const L = Object.fromEntries(["observer", "dc", "degree", "was", "becomes", "apply", "noChanges"].map((k) => [k, loc(`suggest.${k}`)]));
	const lv = (l) => loc(`level.${l}`);
	return foundry.applications.handlebars.renderTemplate(`modules/${MODULE_ID}/templates/suggest.hbs`, {
		...data,
		L,
		intro: loc("suggest.intro"),
		appliedText: loc("suggest.applied", { count: data.rows.filter((r) => r.done).length }),
		rows: data.rows.map((r) => ({ ...r, degree: loc(`degree.${r.degree}`), was: lv(r.was), becomes: lv(r.becomes) }))
	});
}

function onRender(message, html) {
	const data = message.flags?.[MODULE_ID]?.suggest;
	if (!data || data.applied) return;
	const btn = html.querySelector?.("[data-action=apply]");
	if (!btn) return;
	btn.addEventListener("click", async () => {
		if (!game.user.isGM) return;
		const picked = [...html.querySelectorAll("input[data-i]:checked")].map((i) => Number(i.dataset.i));
		btn.disabled = true;
		try {
			await store.applyChanges(picked.map((i) => ({ observerId: data.rows[i].observerId, targetId: data.rows[i].targetId, level: data.rows[i].becomes })), game.scenes.get(data.sceneId));
		} catch (e) {
			console.error(`${MODULE_ID} |`, e);
			ui.notifications.error(loc("notify.applyFailed"));
			btn.disabled = false;
			return;
		}
		const next = { ...data, applied: true, rows: data.rows.map((r, i) => ({ ...r, done: picked.includes(i) })) };
		await message.update({ content: await renderCard(next), [`flags.${MODULE_ID}.suggest`]: next });
	});
}
