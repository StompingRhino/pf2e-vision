import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEL, consequences, attackConsequences, flatDC, actionMode, sameSide, selectObservers,
	degreeOfSuccess, transition, buildDiff, mostVisible, recognizeAction, flatMessageMode, opacityFactor
} from "../scripts/logic.mjs";
import { DEFAULTS, LEVELS, SETTINGS } from "../scripts/constants.mjs";

const cfg = (o = {}) => ({ ...DEFAULTS, ...o });

test("defaults match PLAN section 5", () => {
	assert.equal(SETTINGS.length, 26);
	assert.deepEqual(
		[DEFAULTS["auto.hide"], DEFAULTS["auto.observers"], DEFAULTS["flat.dc.concealed"], DEFAULTS["flat.dc.hidden"],
			DEFAULTS["flat.dc.undetected"], DEFAULTS["flat.onFail"], DEFAULTS["flat.who"], DEFAULTS["visual.hiddenOpacity"]],
		["suggest", "enemies", 5, 11, 11, "miss", "all", 0.45]
	);
});

test("flat DC per level: defaults and custom", () => {
	const d = cfg();
	assert.deepEqual(LEVELS.map((l) => flatDC(l, d)), [null, 5, 11, 11, 11]);
	const c = cfg({ "flat.dc.concealed": 4, "flat.dc.hidden": 12, "flat.dc.undetected": 15 });
	assert.deepEqual(LEVELS.map((l) => flatDC(l, c)), [null, 4, 12, 15, 15]);
});

test("consequences: table 1.2, both sides", () => {
	const d = cfg();
	const got = LEVELS.map((l) => consequences(l, d));
	assert.deepEqual(got.map((c) => c.flatDC), [null, 5, 11, 11, 11]);
	assert.deepEqual(got.map((c) => c.offGuard), [false, false, true, true, true]);
	assert.deepEqual(got.map((c) => c.offGuardDamage), [false, false, true, true, true]);
});

test("consequences respect enable switches", () => {
	const c = consequences("hidden", cfg({ "flat.enabled": false, "offguard.attack": false, "offguard.damage": true }));
	assert.deepEqual(c, { flatDC: null, offGuard: false, offGuardDamage: true });
});

test("attack direction: flat check from getLevel(T,A), off-guard from getLevel(A,T)", () => {
	// T hidden from A, A not hidden from T: A rolls flat DC 11, T not off-guard
	let r = attackConsequences("hidden", "observed", cfg(), { attackerIsPC: true });
	assert.equal(r.flatDC, 11);
	assert.equal(r.offGuard, false);
	// A hidden from T, T clear to A: no flat check, T off-guard
	r = attackConsequences("observed", "hidden", cfg(), { attackerIsPC: false });
	assert.equal(r.flatDC, null);
	assert.equal(r.offGuard, true);
	assert.equal(r.offGuardDamage, true);
	// concealed gives a flat check but no off-guard
	r = attackConsequences("observed", "concealed", cfg(), { attackerIsPC: true });
	assert.equal(r.offGuard, false);
	r = attackConsequences("concealed", "observed", cfg(), { attackerIsPC: true });
	assert.equal(r.flatDC, 5);
});

test("flat.who", () => {
	const at = (who, pc) => attackConsequences("hidden", "observed", cfg({ "flat.who": who }), { attackerIsPC: pc }).flatDC;
	assert.deepEqual([at("all", true), at("all", false)], [11, 11]);
	assert.deepEqual([at("pc", true), at("pc", false)], [11, null]);
	assert.deepEqual([at("npc", true), at("npc", false)], [null, 11]);
});

test("flat.onFail is passed through", () => {
	for (const m of ["miss", "warn", "cancel"]) {
		assert.equal(attackConsequences("hidden", "observed", cfg({ "flat.onFail": m }), { attackerIsPC: true }).onFail, m);
	}
});

test("actionMode per action", () => {
	const c = cfg({ "auto.hide": "off", "auto.sneak": "suggest", "auto.seek": "auto" });
	assert.deepEqual(["hide", "sneak", "seek"].map((a) => actionMode(a, c)), ["off", "suggest", "auto"]);
	assert.equal(actionMode("hide", cfg({ "auto.hide": "garbage" })), "off");
});

test("ally criterion", () => {
	const pc = { alliance: "party", hasPlayerOwner: true };
	const pc2 = { alliance: "party", hasPlayerOwner: true };
	const npc = { alliance: "opposition", hasPlayerOwner: false };
	const familiar = { alliance: "opposition", hasPlayerOwner: true };
	assert.equal(sameSide(pc, pc2, "alliance"), true);
	assert.equal(sameSide(pc, npc, "alliance"), false);
	assert.equal(sameSide(npc, familiar, "alliance"), true);
	assert.equal(sameSide(npc, familiar, "owner"), false);
	assert.equal(sameSide(pc, familiar, "owner"), true);
});

test("auto.observers", () => {
	const hider = { alliance: "party" };
	const others = [{ id: 1, alliance: "party" }, { id: 2, alliance: "opposition" }];
	assert.deepEqual(selectObservers(hider, others, cfg()).map((o) => o.id), [2]);
	assert.deepEqual(selectObservers(hider, others, cfg({ "auto.observers": "all" })).map((o) => o.id), [1, 2]);
});

test("degree of success: boundaries and naturals", () => {
	const d = (t, n) => degreeOfSuccess(t, 15, n);
	assert.equal(d(25), "criticalSuccess");
	assert.equal(d(24), "success");
	assert.equal(d(15), "success");
	assert.equal(d(14), "failure");
	assert.equal(d(6), "failure");
	assert.equal(d(5), "criticalFailure");
	assert.equal(d(24, 20), "criticalSuccess");
	assert.equal(d(14, 20), "success");
	assert.equal(d(5, 20), "failure");
	assert.equal(d(25, 20), "criticalSuccess");
	assert.equal(d(15, 1), "failure");
	assert.equal(d(25, 1), "success");
	assert.equal(d(5, 1), "criticalFailure");
	assert.equal(d(10, 19), "failure");
});

const D = ["criticalSuccess", "success", "failure", "criticalFailure"];
const row = (action, level) => D.map((d) => transition(action, level, d));

test("transitions: Hide", () => {
	for (const l of ["observed", "concealed"]) assert.deepEqual(row("hide", l), ["hidden", "hidden", l, l]);
	for (const l of ["hidden", "undetected", "unnoticed"]) assert.deepEqual(row("hide", l), [l, l, l, l]);
});

test("transitions: Sneak", () => {
	for (const l of ["hidden", "undetected", "unnoticed"]) {
		assert.deepEqual(row("sneak", l), ["undetected", "undetected", "hidden", "observed"]);
	}
	for (const l of ["observed", "concealed"]) assert.deepEqual(row("sneak", l), [l, l, l, l]);
});

test("transitions: Seek", () => {
	assert.deepEqual(row("seek", "hidden"), ["observed", "observed", "hidden", "hidden"]);
	for (const l of ["undetected", "unnoticed"]) assert.deepEqual(row("seek", l), ["observed", "hidden", l, l]);
	for (const l of ["observed", "concealed"]) assert.deepEqual(row("seek", l), [l, l, l, l]);
});

test("mostVisible", () => {
	assert.equal(mostVisible([]), "observed");
	assert.equal(mostVisible(["unnoticed", "hidden", "undetected"]), "hidden");
	assert.equal(mostVisible(["unnoticed"]), "unnoticed");
	assert.equal(mostVisible(["undetected", "observed"]), "observed");
	assert.equal(mostVisible(["bogus"]), "observed");
	assert.equal(mostVisible(new Set(["concealed", "hidden"])), "concealed");
});

test("buildDiff: _del for observed, reverse, no-ops skipped, last wins", () => {
	const state = { "T1|O1": "hidden", "T1|O2": "concealed" };
	const get = (t, o) => state[`${t}|${o}`] ?? "observed";
	const { updates, reverse } = buildDiff(get, [
		{ observerId: "O1", targetId: "T1", level: "observed" },
		{ observerId: "O2", targetId: "T1", level: "concealed" }, // no-op
		{ observerId: "O3", targetId: "T1", level: "hidden" },
		{ observerId: "O3", targetId: "T1", level: "undetected" }, // overrides previous
		{ observerId: "O1", targetId: "T2", level: "unnoticed" }
	]);
	assert.deepEqual(updates, [
		{ _id: "T1", flags: { "pf2e-vision": { visibility: { O1: DEL, O3: "undetected" } } } },
		{ _id: "T2", flags: { "pf2e-vision": { visibility: { O1: "unnoticed" } } } }
	]);
	assert.deepEqual(reverse, [
		{ observerId: "O1", targetId: "T1", level: "hidden" },
		{ observerId: "O3", targetId: "T1", level: "observed" },
		{ observerId: "O1", targetId: "T2", level: "observed" }
	]);
});

test("reverse diff restores the state", () => {
	const state = { "T1|O1": "hidden" };
	const get = (t, o) => state[`${t}|${o}`] ?? "observed";
	const apply = (diff) => {
		for (const u of diff.updates) {
			for (const [o, v] of Object.entries(u.flags["pf2e-vision"].visibility)) {
				if (v === DEL) delete state[`${u._id}|${o}`];
				else state[`${u._id}|${o}`] = v;
			}
		}
	};
	const before = { ...state };
	const fwd = buildDiff(get, [{ observerId: "O1", targetId: "T1", level: "observed" }, { observerId: "O2", targetId: "T1", level: "hidden" }]);
	apply(fwd);
	assert.deepEqual(state, { "T1|O2": "hidden" });
	apply(buildDiff(get, fwd.reverse));
	assert.deepEqual(state, before);
});

test("buildDiff with custom delete marker", () => {
	const marker = Symbol("del");
	const { updates } = buildDiff(() => "hidden", [{ observerId: "O", targetId: "T", level: "observed" }], undefined, marker);
	assert.equal(updates[0].flags["pf2e-vision"].visibility.O, marker);
});

test("recognizeAction: Seek is a perception-check, Hide/Sneak skill-check", () => {
	assert.equal(recognizeAction({ type: "perception-check", options: ["action:seek"] }), "seek");
	assert.equal(recognizeAction({ type: "skill-check", options: ["action:hide"] }), "hide");
	assert.equal(recognizeAction({ type: "skill-check", options: ["action:sneak"] }), "sneak");
	assert.equal(recognizeAction({ type: "attack-roll", options: ["action:seek"] }), null);
	assert.equal(recognizeAction({ type: "skill-check", options: ["action:other"] }), null);
	assert.equal(recognizeAction({ type: "skill-check" }), null);
	assert.equal(recognizeAction(undefined), null);
});

test("flatMessageMode: gm setting or private attack -> gm", () => {
	assert.equal(flatMessageMode("public", "public"), "public");
	assert.equal(flatMessageMode("public", undefined), "public");
	for (const m of ["gm", "self"]) assert.equal(flatMessageMode("public", m), "gm");
	assert.equal(flatMessageMode("public", "blind"), "blind");
	assert.equal(flatMessageMode("gm", "blind"), "blind");
	assert.equal(flatMessageMode("gm", "public"), "gm");
});

test("opacityFactor: hideUndetected=false makes undetected look like hidden", () => {
	const d = cfg();
	assert.deepEqual(LEVELS.map((l) => opacityFactor(l, d)), [undefined, 0.8, 0.45, undefined, undefined]);
	const c = cfg({ "visual.hideUndetected": false });
	assert.deepEqual(LEVELS.map((l) => opacityFactor(l, c)), [undefined, 0.8, 0.45, 0.45, 0.45]);
});

test("pickCombat: active > started on scene (viewed preferred); no drafts, no deleted viewed", async () => {
	const { pickCombat } = await import("../scripts/logic.mjs");
	const mk = (scenes, started = true) => ({ started, combatants: scenes.map((sceneId) => ({ sceneId })) });
	const a = mk(["s2"]), v = mk(["s1"]), st = mk(["s1"]), draft = mk(["s1"], false);
	assert.equal(pickCombat({ active: a, viewed: v, contents: [a, v, st] }, "s1"), a);
	assert.equal(pickCombat({ active: null, viewed: v, contents: [st, v] }, "s1"), v);
	assert.equal(pickCombat({ active: null, viewed: mk(["s2"]), contents: [st] }, "s1"), st);
	assert.equal(pickCombat({ active: null, viewed: draft, contents: [draft] }, "s1"), null);
	assert.equal(pickCombat({ active: null, viewed: v, contents: [] }, "s1"), null); // viewed already deleted
	assert.equal(pickCombat({ active: null, viewed: null, contents: [st] }, "s2"), null);
	assert.equal(pickCombat(undefined, "s1"), null);
});
