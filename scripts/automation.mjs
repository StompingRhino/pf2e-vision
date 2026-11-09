import { MODULE_ID, loc, levelChip } from "./constants.mjs";
import { getConfig } from "./settings.mjs";
import { actionMode, degreeOfSuccess, transition, selectObservers, seekAreaTargets, coneOriginOk, recognizeAction } from "./logic.mjs";
import * as store from "./store.mjs";
import { ConfirmApp } from "./confirm-app.mjs";


export function init() {}

export function ready() {
	Hooks.on("createChatMessage", onCreate);
	Hooks.on("createRegion", onRegion);
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

const onCreate = (message) => (game.user === game.users.activeGM ? run(message) : undefined);

/** Seek without explicit targets: the author picks the area after the roll (pf2e's own area links place the region). */
async function postAreaCard(message, seeker, scene) {
	const whisper = [...new Set([message.author?.id, ...ChatMessage.getWhisperRecipients("GM").map((u) => u.id)])].filter(Boolean);
	return ChatMessage.create({
		content: areaCard(false),
		whisper,
		speaker: { alias: "PF2e Vision" },
		flags: { [MODULE_ID]: { seekArea: { seekMessageId: message.id, sceneId: scene.id, seekerId: seeker.id, done: false } } }
	});
}

function areaCard(done) {
	const e = foundry.utils.escapeHTML;
	const link = (type, distance, icon) => `<a class="effect-area" data-effect-area data-type="${type}" data-distance="${distance}"><i class="fa-solid ${icon}"></i> ${e(loc(`seekArea.${type}`, { distance }))}</a>`;
	const body = done
		? `<p>${e(loc("seekArea.chosen"))}</p>`
		: `<p class="pf2ev-sintro">${e(loc("seekArea.intro"))}</p><p>${link("burst", 15, "fa-circle-dot")} &nbsp; ${link("cone", 30, "fa-location-arrow")}</p>`;
	return `<div class="pf2ev-sheet"><header class="pf2ev-card-head"><i class="fa-solid fa-eye" aria-hidden="true"></i><span>${e(loc("seekArea.title"))}</span></header><div class="pf2ev-note">${body}</div></div>`;
}

/** A region placed from the area card: the active GM computes the Seek once, then removes the region. */
async function onRegion(region) {
	if (game.user !== game.users.activeGM) return;
	const card = game.messages.get(region.flags?.pf2e?.messageId);
	const area = card?.flags?.[MODULE_ID]?.seekArea;
	if (!area) return;
	if (area.done || region.parent?.id !== area.sceneId) return region.delete();   // повторный клик по ещё не перерисованной карточке
	const seekMessage = game.messages.get(area.seekMessageId);
	const scene = region.parent;
	const seeker = scene.tokens.get(area.seekerId);
	const shape = region.shapes[0];
	const g = scene.grid.size;
	const rect = seeker && { x: seeker.x, y: seeker.y, width: seeker.width * g, height: seeker.height * g };
	if (shape?.type === "cone" && rect && !coneOriginOk(shape, rect, g)) {
		await region.delete();
		return ChatMessage.create({
			content: `<div class="pf2ev-sheet"><div class="pf2ev-note"><p>${foundry.utils.escapeHTML(loc("seekArea.coneOrigin"))}</p></div></div>`,
			whisper: [...new Set([seekMessage?.author?.id, ...ChatMessage.getWhisperRecipients("GM").map((u) => u.id)])].filter(Boolean),
			speaker: { alias: "PF2e Vision" }
		});
	}
	await card.update({ content: areaCard(true), [`flags.${MODULE_ID}.seekArea.done`]: true });
	try {
		if (seekMessage) await run(seekMessage, region);
	} finally {
		await region.delete();
	}
}

async function run(message, region = null) {
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
		const ids = region ? new Set() : await seekTargetIds(message, ctx);
		// explicit targets: only them; none: the author picks an area, then those inside it who are hidden from the seeker
		let targets;
		if (ids.size) {
			targets = others.filter((p) => ids.has(p.id));
			if (!targets.length) note = loc("suggest.noTargets");
		} else if (!region) {
			return postAreaCard(message, actorTok, scene);
		} else {
			targets = seekAreaTargets(others, (p) => p.tok.testInsideRegion(region), (p) => store.getLevel(p.id, me.id, scene));
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
