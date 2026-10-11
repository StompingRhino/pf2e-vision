const ID = "pf2e-vision-proto-1";
const LEVELS = ["observed", "concealed", "hidden", "undetected", "unnoticed"];
const ICON = (k) => `systems/pf2e/icons/conditions/${k}.webp`;
const ALPHA = { concealed: 0.8, hidden: 0.45 };
const t = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
const lvlName = (k) => t(`PF2EVP1.Level.${k}`);

/* ---------- data helpers ---------- */

/** Flag lives on the target token: flags[ID].visibility = { [observerTokenId]: level }. Missing = observed. */
const getLevel = (targetDoc, observerId) => targetDoc.getFlag(ID, "visibility")?.[observerId] ?? "observed";

function combatTokens() {
  const combat = game.combat;
  if (!combat || !canvas.scene) return [];
  return combat.combatants.map((c) => c.token).filter((d) => d?.parent === canvas.scene);
}

/** Batch write; only the GM may do it. pairs: [{observerId, targetId, level}] */
async function applyLevels(pairs) {
  if (!game.user.isGM) return;
  const byTarget = new Map();
  for (const { observerId, targetId, level } of pairs) {
    if (observerId === targetId) continue;
    const u = byTarget.get(targetId) ?? { _id: targetId };
    if (level === "observed") u[`flags.${ID}.visibility.-=${observerId}`] = null;
    else u[`flags.${ID}.visibility.${observerId}`] = level;
    byTarget.set(targetId, u);
  }
  if (byTarget.size) await canvas.scene.updateEmbeddedDocuments("Token", [...byTarget.values()]);
}

/* ---------- canvas visuals ---------- */

/** Level of `token` as seen by the local user: most visible among the user's observers (owned tokens; for GM: controlled tokens). */
function effectiveLevel(token) {
  const doc = token.document;
  if (!game.combat || doc.combatant?.parent !== game.combat) return null;
  const observers = canvas.tokens.placeables.filter((o) => o !== token && o.document.combatant?.parent === game.combat
    && (game.user.isGM ? o.controlled : o.document.isOwner));
  if (!observers.length) return null;
  return LEVELS[Math.min(...observers.map((o) => LEVELS.indexOf(getLevel(doc, o.id))))];
}

const textures = {};
async function badgeTexture(level) {
  return (textures[level] ??= foundry.canvas.loadTexture(ICON(level)));
}

async function setBadge(token, level) {
  let b = token._p1Badge;
  if (!level || level === "observed") return void (b && !b.destroyed && (b.visible = false));
  if (!b || b.destroyed) {
    b = token._p1Badge = new PIXI.Sprite();
    b.width = b.height = 24;
    token.addChild(b);
  }
  b.texture = await badgeTexture(level);
  b.width = b.height = 24;
  b.position.set(2, 2);
  b.visible = true;
}

Hooks.on("refreshToken", (token, flags) => {
  if (!token.mesh) return;
  const level = effectiveLevel(token);
  if (flags.refreshVisibility || flags.redraw) {
    if (!game.user.isGM && (level === "undetected" || level === "unnoticed")) token.visible = false;
  }
  // refreshState resets mesh.alpha first, so multiplying once per refreshState is safe
  if (flags.refreshState && !game.user.isGM && ALPHA[level]) token.mesh.alpha *= ALPHA[level];
  setBadge(token, level); // GM sees everything, only the badge (relative to controlled tokens)
});

function refreshAllTokens() {
  if (!canvas.ready) return;
  for (const tk of canvas.tokens.placeables) tk.renderFlags.set({ refreshState: true, refreshVisibility: true });
}

/* ---------- prototype stubs ---------- */

// prototype: real mechanics go here. Flat check DC 5 (concealed) / 11 (hidden, undetected); off-guard via pf2e
// conditions (undetected/unnoticed targets are off-guard). Stealth/Hide/Sneak/Seek automation via Workbench/Toolbelt.
function mechanicsStub(observerId, targetId, level) {
  console.debug(`${ID} | prototype: ${observerId} -> ${targetId} = ${level}; flat DC ${{ concealed: 5, hidden: 11, undetected: 11 }[level] ?? "-"}`);
}

/* ---------- matrix window ---------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class VisibilityMatrix extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  fill = "hidden";

  static DEFAULT_OPTIONS = {
    id: "pf2e-vision-proto-1-matrix",
    classes: ["pf2e-vision-proto"],
    window: { title: "PF2EVP1.Title", resizable: true, icon: "fa-solid fa-table-cells" },
    position: { width: "auto", height: "auto" },
    actions: {
      setLevel: VisibilityMatrix.#setLevel,
      fillRow: VisibilityMatrix.#fillRow,
      fillColumn: VisibilityMatrix.#fillColumn
    }
  };

  static PARTS = { body: { template: `modules/${ID}/templates/matrix.hbs` } };

  async _prepareContext() {
    const docs = combatTokens();
    const rows = docs.map((obs) => ({
      tokenId: obs.id, name: obs.name, img: obs.texture.src,
      cells: docs.map((tgt) => {
        const level = getLevel(tgt, obs.id);
        return {
          observerId: obs.id, targetId: tgt.id, self: obs === tgt,
          buttons: LEVELS.map((key) => ({
            key, icon: ICON(key), active: key === level,
            tip: t("PF2EVP1.CellTip", { observer: obs.name, target: tgt.name, level: lvlName(key) })
          }))
        };
      })
    }));
    return {
      empty: !rows.length, rows,
      levels: LEVELS.map((key) => ({ key, label: lvlName(key), selected: key === this.fill })),
      rowTip: t("PF2EVP1.RowAll"), colTip: t("PF2EVP1.ColAll")
    };
  }

  _onRender() {
    this.element.querySelector("select[name=fill]")?.addEventListener("change", (e) => { this.fill = e.target.value; });
  }

  static async #setLevel(event, el) {
    const { observer, target, level } = el.dataset;
    mechanicsStub(observer, target, level);
    await applyLevels([{ observerId: observer, targetId: target, level }]);
  }

  static async #fillRow(event, el) {
    const observerId = el.dataset.observer;
    await applyLevels(combatTokens().map((d) => ({ observerId, targetId: d.id, level: this.fill })));
  }

  static async #fillColumn(event, el) {
    const targetId = el.dataset.target;
    await applyLevels(combatTokens().map((d) => ({ observerId: d.id, targetId, level: this.fill })));
  }

  static open() {
    return (this.instance ??= new this()).render({ force: true });
  }
}

/* ---------- wiring ---------- */

Hooks.on("renderCombatTracker", (app, html) => {
  if (!game.user.isGM || html.querySelector("[data-p1-open]")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.p1Open = "1";
  btn.className = "inline-control icon fa-solid fa-table-cells";
  btn.dataset.tooltip = t("PF2EVP1.Open");
  btn.ariaLabel = t("PF2EVP1.Open");
  btn.addEventListener("click", () => VisibilityMatrix.open());
  (html.querySelector("nav") ?? html.querySelector("header") ?? html).append(btn);
});

Hooks.once("ready", () => {
  const rerender = () => { VisibilityMatrix.instance?.rendered && VisibilityMatrix.instance.render(); };
  for (const h of ["createCombatant", "deleteCombatant", "updateCombatant", "updateCombat", "deleteCombat", "createToken", "deleteToken"]) {
    Hooks.on(h, () => { rerender(); refreshAllTokens(); });
  }
  Hooks.on("updateToken", (doc, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${ID}`)) { rerender(); refreshAllTokens(); }
  });
  Hooks.on("controlToken", () => refreshAllTokens());
  Hooks.on("canvasReady", () => refreshAllTokens());
});
