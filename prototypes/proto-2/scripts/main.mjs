const ID = "pf2e-vision-proto-2";
const FLAG = "visibility"; // flags[ID].visibility = { [observerTokenId]: state }; no key = observed
const STATES = ["observed", "concealed", "hidden", "undetected", "unnoticed"];
const ICONS = ["fa-eye", "fa-cloud", "fa-eye-slash", "fa-ghost", "fa-user-secret"];
const ALPHA = [1, 0.7, 0.4, 0, 0]; // players: undetected/unnoticed are hidden outright
const open = new Set(); // combatant ids with expanded panel; survives tracker re-render

const label = (i) => game.i18n.localize(`PFV.State.${STATES[i]}`);
const levelOf = (targetDoc, observerId) => Math.max(0, STATES.indexOf(targetDoc?.getFlag(ID, FLAG)?.[observerId]));

// prototype: DC 5 flat check for concealed, DC 11 for hidden/undetected, off-guard via pf2e; not wired to rolls.
export function rollStub(level) {
  return { flatDC: level === 1 ? 5 : level >= 2 ? 11 : null, offGuard: level >= 3 };
}
// prototype: Stealth/Hide/Sneak/Seek automation through Workbench/Toolbelt would hook in here.

function combatantsOnScene(combat) {
  return combat.combatants.filter((c) => c.token && c.token.parent?.id === canvas.scene?.id);
}

async function setLevels(targetDoc, observerIds, level) {
  if (!game.user.isGM) return;
  const upd = {};
  for (const id of observerIds) upd[`flags.${ID}.${FLAG}.${level ? id : "-=" + id}`] = level ? STATES[level] : null;
  await targetDoc.update(upd);
}

function summary(targetDoc, others) {
  const counts = new Array(5).fill(0);
  for (const o of others) counts[levelOf(targetDoc, o.token.id)]++;
  return counts.map((n, i) => (i && n ? `<span data-tooltip="${label(i)}"><i class="fa-solid ${ICONS[i]}"></i>${n}</span>` : "")).join("");
}

function sliderRow(name, level, mixed, cls, data) {
  return `<div class="pfv-row ${cls}"><span class="pfv-name">${name}</span>
    <input type="range" min="0" max="4" step="1" value="${level}" ${data}>
    <span class="pfv-val">${mixed ? game.i18n.localize("PFV.Mixed") : label(level)}</span></div>`;
}

function buildPanel(combat, c) {
  const target = c.token;
  const others = combatantsOnScene(combat).filter((o) => o.id !== c.id);
  const panel = document.createElement("div");
  panel.className = "pfv-panel";
  let html = `<h4>${game.i18n.localize("PFV.Title")}</h4>`;
  if (!others.length) html += `<p>${game.i18n.localize("PFV.Empty")}</p>`;
  else {
    for (const [key, loc, test] of [["pc", "PFV.AllPC", (o) => o.actor?.hasPlayerOwner], ["npc", "PFV.AllNPC", (o) => !o.actor?.hasPlayerOwner]]) {
      const grp = others.filter(test);
      if (!grp.length) continue;
      const lv = grp.map((o) => levelOf(target, o.token.id));
      const mixed = new Set(lv).size > 1;
      html += sliderRow(game.i18n.localize(loc), mixed ? 0 : lv[0], mixed, "pfv-group", `data-group="${key}"`);
    }
    for (const o of others) html += sliderRow(foundry.utils.escapeHTML(o.name), levelOf(target, o.token.id), false, "", `data-observer="${o.token.id}"`);
  }
  panel.innerHTML = html;
  panel.addEventListener("input", (ev) => { // live label only; flag written on release
    const val = ev.target.closest(".pfv-row")?.querySelector(".pfv-val");
    if (val) val.textContent = label(Number(ev.target.value));
  });
  panel.addEventListener("change", (ev) => {
    const level = Number(ev.target.value);
    const { group, observer } = ev.target.dataset;
    const ids = observer ? [observer]
      : others.filter((o) => (group === "pc") === !!o.actor?.hasPlayerOwner).map((o) => o.token.id);
    setLevels(target, ids, level);
  });
  return panel;
}

// renderCombatTracker also fires for pf2e's EncounterTracker (hooks run along the class chain); html is an HTMLElement in v14.
Hooks.on("renderCombatTracker", (app, html) => {
  if (!game.user.isGM) return;
  const combat = app.viewed;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!combat || !root) return;
  for (const li of root.querySelectorAll("li.combatant[data-combatant-id]")) {
    const c = combat.combatants.get(li.dataset.combatantId);
    if (!c?.token) continue;
    li.classList.add("pfv-host");
    const others = combatantsOnScene(combat).filter((o) => o.id !== c.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "inline-control combatant-control icon fa-solid fa-eye pfv-btn";
    btn.dataset.tooltip = game.i18n.localize("PFV.Toggle");
    btn.ariaLabel = btn.dataset.tooltip;
    btn.classList.toggle("active", open.has(c.id));
    // fragile: relies on .combatant-controls and .token-name existing in the row markup
    li.querySelector(".combatant-controls")?.prepend(btn);
    const sum = document.createElement("span");
    sum.className = "pfv-summary";
    sum.innerHTML = summary(c.token, others);
    li.querySelector(".token-name")?.append(sum);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // keep core tracker actions from firing
      const existing = li.querySelector(":scope > .pfv-panel");
      if (existing) { existing.remove(); open.delete(c.id); } else { li.append(buildPanel(combat, c)); open.add(c.id); }
      btn.classList.toggle("active", open.has(c.id));
    });
    if (open.has(c.id)) li.append(buildPanel(combat, c));
  }
});

// Canvas: what the current user perceives of a token (players: most visible level over owned observer tokens; GM: most hidden level).
function perceived(token) {
  const doc = token.document;
  const flag = doc.getFlag(ID, FLAG);
  if (!flag || !doc.combatant) return 0;
  if (game.user.isGM) return Math.max(0, ...Object.values(flag).map((s) => STATES.indexOf(s)));
  if (doc.isOwner) return 0;
  const mine = canvas.tokens.placeables.filter((t) => t.document.isOwner && t.document.combatant && t.id !== token.id);
  if (!mine.length) return 0;
  return Math.min(...mine.map((t) => Math.max(0, STATES.indexOf(flag[t.id]))));
}

Hooks.on("refreshToken", (token) => {
  if (!token.mesh) return;
  const lv = perceived(token);
  if (!game.user.isGM) {
    if (lv >= 3) token.visible = false;
    else if (lv > 0) token.mesh.alpha = Math.min(token.mesh.alpha, ALPHA[lv]);
  }
  let ind = token._pfvIndicator;
  if (lv < 1 || (!game.user.isGM && lv < 2)) { if (ind) ind.visible = false; return; }
  if (!ind) {
    ind = token._pfvIndicator = new PIXI.Text("", { fontSize: 14, fill: 0xffffff, stroke: 0x000000, strokeThickness: 3, fontWeight: "bold" });
    ind.position.set(2, 2);
    token.addChild(ind);
  }
  ind.text = label(lv);
  ind.visible = true;
});

Hooks.on("updateToken", (doc, change) => {
  if (!foundry.utils.hasProperty(change, `flags.${ID}`)) return;
  doc.object?.renderFlags.set({ refreshVisibility: true, refreshState: true });
  if (game.user.isGM) ui.combat?.render();
});
