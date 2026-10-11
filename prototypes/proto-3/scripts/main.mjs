const MODULE_ID = "pf2e-vision-proto-3";
const STATES = ["observed", "concealed", "hidden", "undetected", "unnoticed"];
const ICON = (s) => `systems/pf2e/icons/conditions/${s}.webp`;
const loc = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
const esc = (s) => foundry.utils.escapeHTML?.(s) ?? s;

/** Map observerTokenId -> state, stored on the target token document. */
const readMap = (doc) => doc.flags?.[MODULE_ID]?.visibility ?? {};
const rank = (s) => Math.max(0, STATES.indexOf(s));

function combatTokens() {
  const combat = game.combat;
  if (!combat) return [];
  return combat.combatants.map((c) => c.token?.object).filter((t) => t && t.scene === canvas.scene);
}

function refreshAll() {
  for (const t of canvas.tokens?.placeables ?? []) t.renderFlags.set({ refreshState: true });
}

class VisionPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf2e-vision-proto-3-panel",
    classes: ["pf2e-vision-panel"],
    position: { width: 300, height: "auto" },
    window: { icon: "fa-solid fa-eye", resizable: false }
  };

  targetId = null;
  #highlight = null;

  get target() {
    return canvas.tokens.get(this.targetId) ?? null;
  }

  get title() {
    return this.target ? loc("PF2EVISION.Title", { name: this.target.name }) : loc("PF2EVISION.Toggle");
  }

  setTarget(token) {
    this.targetId = token?.id ?? null;
    this.render({ force: true });
  }

  async _renderHTML() {
    const target = this.target;
    if (!game.combat) return `<p class="pv-hint">${loc("PF2EVISION.NoCombat")}</p>`;
    if (!target) return `<p class="pv-hint">${loc("PF2EVISION.Hint")}</p>`;
    const obs = combatTokens().filter((t) => t.id !== this.targetId);
    if (!obs.length) return `<p class="pv-hint">${loc("PF2EVISION.NoObservers")}</p>`;
    const map = readMap(target.document);
    return obs.map((o) => {
      const s = map[o.id] ?? "observed";
      const flat = s === "observed" ? "" : ` — ${loc(`PF2EVISION.Flat.${s}`)}`;
      return `<div class="pv-row" data-observer="${o.id}">
        <span class="pv-name">${esc(o.name)}</span>
        <input type="range" min="0" max="4" step="1" value="${rank(s)}">
        <img class="pv-icon" src="${ICON(s)}" alt="">
        <span class="pv-state">${loc(`PF2EVISION.State.${s}`)}${flat}</span>
      </div>`;
    }).join("");
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  async _onRender() {
    for (const row of this.element.querySelectorAll(".pv-row")) {
      const id = row.dataset.observer;
      row.addEventListener("mouseenter", () => this.#highlightToken(canvas.tokens.get(id)));
      row.addEventListener("mouseleave", () => this.#highlightToken(null));
      row.querySelector("input").addEventListener("change", (ev) => this.#setState(id, STATES[ev.target.value]));
    }
    this.#place();
    refreshAll();
  }

  async _onClose() {
    this.#highlightToken(null);
    refreshAll();
  }

  async #setState(observerId, state) {
    // GM only: players cannot update other tokens' flags anyway.
    if (!game.user.isGM || !this.target) return;
    const path = `flags.${MODULE_ID}.visibility`;
    const update = state === "observed" ? { [`${path}.-=${observerId}`]: null } : { [`${path}.${observerId}`]: state };
    await this.target.document.update(update);
    // prototype: no roll mechanics here. Real version: sync off-guard / flat check effects via pf2e + Workbench/Toolbelt.
  }

  #highlightToken(token) {
    this.#highlight?.destroy();
    this.#highlight = null;
    if (!token) return;
    const g = new PIXI.Graphics();
    g.lineStyle(5, 0xffd54a, 1).drawRect(token.x, token.y, token.w, token.h);
    canvas.interface.addChild(g);
    this.#highlight = g;
  }

  /** Dock next to the target token; pin to the screen edge if there is no room. */
  #place() {
    const t = this.target;
    const w = this.position.width || 300;
    let left = 10;
    let top = 80;
    if (t) {
      const rect = canvas.app.view.getBoundingClientRect();
      const m = canvas.stage.worldTransform;
      const tl = m.apply({ x: t.x, y: t.y });
      const br = m.apply({ x: t.x + t.w, y: t.y + t.h });
      top = Math.max(10, Math.min(rect.top + tl.y, window.innerHeight - 200));
      if (rect.left + br.x + 10 + w < window.innerWidth - 320) left = rect.left + br.x + 10;
      else if (rect.left + tl.x - w - 10 > 0) left = rect.left + tl.x - w - 10;
      // else: pinned at the left edge (defaults above)
    }
    this.setPosition({ left, top });
  }
}

let panel = null;
const getPanel = () => (panel ??= new VisionPanel());

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.pf2eVisionProto3 = {
    name: "pf2eVisionProto3",
    title: "PF2EVISION.Toggle",
    icon: "fa-solid fa-eye-low-vision",
    order: Object.keys(tools).length,
    toggle: true,
    active: !!panel?.rendered,
    onChange: (_event, active) => {
      const p = getPanel();
      if (!active) return p.close();
      p.targetId = canvas.tokens.controlled.find((t) => t.inCombat)?.id ?? null;
      p.render({ force: true });
    }
  };
});

Hooks.on("controlToken", (token, controlled) => {
  if (!controlled || !panel?.rendered || !token.inCombat) return;
  panel.setTarget(token);
});

for (const h of ["updateToken", "createCombatant", "deleteCombatant", "deleteCombat", "updateCombat"]) {
  Hooks.on(h, () => {
    if (panel?.rendered) panel.render();
    else refreshAll();
  });
}
Hooks.on("canvasReady", () => panel?.rendered && panel.close());

// --- Canvas visuals --------------------------------------------------------

async function setBadge(token, state) {
  const find = () => token.children.find((c) => c.name === "pvBadge");
  const old = find();
  if (!state || state === "observed") return void old?.destroy();
  if (old?.pvState === state) return;
  old?.destroy();
  const tex = await foundry.canvas.loadTexture(ICON(state));
  if (token.destroyed) return;
  find()?.destroy(); // a concurrent refresh may have added one while the texture loaded
  const b = new PIXI.Sprite(tex);
  b.name = "pvBadge";
  b.pvState = state;
  b.width = b.height = Math.max(20, token.h / 3);
  b.position.set(token.w - b.width, 0);
  token.addChild(b);
}

Hooks.on("refreshToken", (token) => {
  if (!canvas.ready) return;
  if (game.user.isGM) {
    // GM sees every token; badge shows the panel target's state *for this observer*.
    const target = panel?.rendered ? panel.target : null;
    const state = target && target.id !== token.id ? readMap(target.document)[token.id] : null;
    return void setBadge(token, state);
  }
  // Player: most visible level among owned combat tokens (observers).
  const mine = combatTokens().filter((t) => t.isOwner && t.id !== token.id);
  let state = "observed";
  if (mine.length && !token.isOwner) {
    const map = readMap(token.document);
    state = STATES[Math.min(...mine.map((o) => rank(map[o.id] ?? "observed")))];
  }
  setBadge(token, state);
  const r = rank(state);
  if (r >= 3) token.visible = false; // undetected / unnoticed
  else if (token.mesh) {
    token.visible = token.isVisible;
    if (r === 2) token.mesh.alpha = Math.min(token.mesh.alpha, 0.45); // hidden
    else if (r === 1) token.mesh.alpha = Math.min(token.mesh.alpha, 0.8); // concealed
  }
});

Hooks.once("ready", () => {
  // prototype: Workbench/Toolbelt integration (Stealth/Hide/Sneak/Seek automation) is not wired.
  console.log(`${MODULE_ID} | ready`);
});
