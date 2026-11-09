import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEL, consequences, attackConsequences, flatDC, actionMode, sameSide, selectObservers,
	confirmRows, pickChanges, degreeOfSuccess, transition, buildDiff, mostVisible, recognizeAction, flatMessageMode, opacityFactor, adjustFlatDC
} from "../scripts/logic.mjs";
import { DEFAULTS, LEVELS, SETTINGS } from "../scripts/constants.mjs";

test("Keen Eyes / Blind-Fight: flat DC of the attacker, off-guard of the target", () => {
	const keen = ["feature:keen-eyes"], blind = ["feat:blind-fight"];
	const at = (lvl, o = {}) => attackConsequences(lvl, "observed", cfg(), { attackerIsPC: true, ...o });
	assert.deepEqual(["concealed", "hidden", "undetected"].map((l) => at(l, { attackerOptions: keen }).flatDC), [3, 9, 11]);
	assert.deepEqual(["concealed", "hidden", "undetected"].map((l) => at(l, { attackerOptions: blind }).flatDC), [null, 5, 11]);
	assert.deepEqual(["concealed", "hidden"].map((l) => at(l, { attackerOptions: [...keen, ...blind] }).flatDC), [null, 5]);   // lowest wins
	assert.equal(at("hidden").flatDC, 11);   // without feats — world setting
	assert.equal(adjustFlatDC(2, "concealed", keen), 2);   // never raises a lower world DC
	assert.equal(adjustFlatDC(null, "observed", keen), null);
	// Blind-Fight: not off-guard to a hidden attacker, still off-guard to an undetected one
	const def = (lvl, targetOptions) => attackConsequences("observed", lvl, cfg(), { attackerIsPC: true, targetOptions });
	assert.equal(def("hidden", blind).offGuard, false);
	assert.equal(def("hidden", []).offGuard, true);
	assert.equal(def("undetected", blind).offGuard, true);
});

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

test("confirm window: all observers listed, default = computed level, tick only on change", () => {
	const rows = [
		{ observerId: "a", targetId: "t", was: "observed", becomes: "hidden" },
		{ observerId: "b", targetId: "t", was: "observed", becomes: "observed" }
	];
	const w = confirmRows(rows);
	assert.equal(w.length, 2);
	assert.deepEqual(w.map((r) => [r.level, r.apply]), [["hidden", true], ["observed", false]]);
});

test("confirm window: edited level and ticks go to the changes", () => {
	const rows = [
		{ observerId: "a", targetId: "t", was: "observed", becomes: "hidden" },
		{ observerId: "b", targetId: "t", was: "observed", becomes: "observed" },
		{ observerId: "c", targetId: "t", was: "hidden", becomes: "undetected" }
	];
	const edits = [
		{ apply: true, level: "undetected" }, // edited
		{ apply: true, level: "concealed" },  // unchanged observer fixed by hand
		{ apply: false, level: "undetected" } // unticked
	];
	assert.deepEqual(pickChanges(rows, edits), [
		{ observerId: "a", targetId: "t", level: "undetected" },
		{ observerId: "b", targetId: "t", level: "concealed" }
	]);
	assert.deepEqual(pickChanges(rows, [{ apply: true, level: "observed" }, { apply: true, level: "bogus" }]), []);
});

import { isCastCall, needsSpellFlat, seekAreaTargets, coneOriginOk } from "../scripts/logic.mjs";

test("spell flat check: only an outermost real cast, only targeted non-attack non-area spells", () => {
	assert.equal(isCastCall({ actualCast: true }, 0), true);
	assert.equal(isCastCall({ actualCast: true, create: false }, 0), false);   // variant button
	assert.equal(isCastCall({}, 0), false);   // card preview from the sheet
	assert.equal(isCastCall({ actualCast: true }, 1), false);   // nested variant call
	const spell = (o) => ({ isAttack: false, area: null, system: { target: { value: "1 creature" } }, ...o });
	assert.equal(needsSpellFlat(spell()), true);
	assert.equal(needsSpellFlat(spell({ isAttack: true })), false);
	assert.equal(needsSpellFlat(spell({ area: { type: "burst" } })), false);
	assert.equal(needsSpellFlat(spell({ system: { target: { value: "" } } })), false);
});

test("Seek area: inside the region and hidden from the seeker", () => {
	const ps = [{ id: "a" }, { id: "b" }, { id: "c" }];
	const lv = { a: "hidden", b: "observed", c: "undetected" };
	assert.deepEqual(seekAreaTargets(ps, (p) => p.id !== "c", (p) => lv[p.id]).map((p) => p.id), ["a"]);
	assert.deepEqual(seekAreaTargets(ps, () => true, (p) => lv[p.id]).map((p) => p.id), ["a", "c"]);
});

test("Seek cone vertex must be at the seeker", () => {
	const rect = { x: 500, y: 300, width: 100, height: 100 };
	assert.equal(coneOriginOk({ x: 550, y: 350 }, rect, 100), true);
	assert.equal(coneOriginOk({ x: 700, y: 350 }, rect, 100), true);   // neighbouring cell edge
	assert.equal(coneOriginOk({ x: 900, y: 350 }, rect, 100), false);
	assert.equal(coneOriginOk({ x: 550, y: 100 }, rect, 100), false);
});
