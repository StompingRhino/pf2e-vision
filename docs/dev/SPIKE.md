# Спайк в живом Foundry — результаты (2026-10-10)

Мир `pf2test` (ТОЛЬКО он), Foundry **14.360**, pf2e **8.1.2**, PIXI **7.4.3**, lib-wrapper, Toolbelt 3.51.1, Workbench 7.3.3.
Исходники клиента ядра v14: `../pf2e-vision-dev/ref/foundry.mjs` (213k строк) — искать `grep -n`, не читать целиком.
Модуль установлен КОПИЕЙ в `Data/modules/pf2e-vision` (2026-10-11, вместо junction): после правок в этом каталоге скопировать `module.json README.md scripts templates styles lang` туда заново, затем F5.

Также в мире активны: `conditional-visibility`, `pf2e-automations`, `pf2e-auto-action-tracker`, `monks-combat-details`, `dfreds-*`, `token-action-hud-*` — учитывать возможные конфликты.

## Подтверждено вживую

1. **PIXI 7.4.3** — `Graphics#lineStyle` есть.
2. **Скрытие токена — только через геттер `isVisible`.** Геттер определён в `Token` (core, `../pf2e-vision-dev/ref/foundry.mjs:166334`), `CONFIG.Token.objectClass` = `TokenPF2e`.
   `PlaceableObject#_refreshVisibility` (54167): `this.visible = this.isVisible`; `Token#_refreshVisibility` (167127): `this.mesh.visible = this.visible && this.renderable`.
   Меш живёт в `PrimaryCanvasGroup`, НЕ в контейнере токена → `token.visible=false` в хуке `refreshToken` арт НЕ прячет.
   Подмена `isVisible` → `token.visible=false` и `mesh.visible=false` (проверено). Обёртка: `libWrapper.register(MODULE_ID, "CONFIG.Token.objectClass.prototype.isVisible", fn, "WRAPPER")`.
   После изменения уровней: `token.renderFlags.set({refreshVisibility: true, refreshState: true})`.
   Прозрачность: `Token#_refreshState` ставит `mesh.alpha = this.alpha * document.alpha` (167150) — менять alpha ПОСЛЕ этого (хук `refreshToken`) идемпотентно `Math.min`.
3. **Трекер боя:** класс `EncounterTracker extends CombatTracker`; хук `renderCombatTracker(app, html: HTMLElement, context, options)` — срабатывает и при частичном рендере (`options.parts`, например `["header"]`). Кнопку вставлять в `header.combat-tracker-header nav.encounters` (там кнопки `button.inline-control.icon` с `data-action`), идемпотентно (проверять, что кнопки ещё нет).
4. **Бой НЕ привязан к сцене** в этом мире: `game.combats.active.scene === null`. «Активный бой сцены» не годится. Бой токена: `tokenDoc.combatant?.parent` (работает), активный — `game.combats.active`.
5. **`Check.roll` контекст атаки** (тип `"attack-roll"`), ключи: `type, identifier, action, title, actor, token, origin, target, item, altUsage, damaging, domains, options, notes, dc, traits, rollTwice, substitutions, dosAdjustments, mapIncreases, createMessage`.
   `context.target.actor` — УЖЕ клон pf2e (≠ token.actor), `context.target.token` — `TokenDocumentPF2e`, `context.origin.{actor,token}`, `context.dc = {value, slug:"armor", statistic: StatisticDifficultyClass}`, `context.options` — Set строк (`target:condition:off-guard`, `target:enemy`, …), `context.dosAdjustments` — массив.
   libWrapper от имени `pf2e-vision` работает. Возврат `null` из обёртки — бросок отменён, сообщения нет.
   НИКОГДА не присваивать `game.pf2e.Check.roll = …` вручную — lib-wrapper уже оборачивает метод, присваивание зацикливает клиент.
6. **Промах через `dosAdjustments` — работает:** добавить `{adjustments: {success: {label, amount: "failure"}, criticalSuccess: {label, amount: "failure"}}}` → нескорректированный `criticalSuccess` стал `failure`, в сообщении «Критическое попадание → Промах», label в flavor. Авто-урон Workbench при этом НЕ бросился. `context.outcome/unadjustedOutcome` доступны после `wrapped()`.
7. **Окна бросков:** в мире включено «Показывать всегда» — окно атаки/урона появляется даже при `skipDialog:true` в параметрах strike; в обёртке `context.skipDialog = true` окно отключает. ВАЖНО: обёртка выполняется ДО окна → чистую проверку бросать так, чтобы игрок не мог «переиграть» провал закрытием окна: бросить d20 молча, сообщение о чистой проверке публиковать только если `wrapped()` вернул результат (не `null`).
8. **Чистая проверка:** `game.pf2e.Statistic` НЕ экспортирован. Варианты: базовый класс `Object.getPrototypeOf(actor.perception.constructor)` (Statistic) → `new Statistic(actor, {slug, label, check: {type: "flat-check"}, domains: []}).roll({dc: {value}, skipDialog: true})` (как `rollRecovery`, pf2e.mjs:53662); либо `game.pf2e.Check.roll(new game.pf2e.CheckModifier(label, {modifiers: []}), {type: "flat-check", actor, dc: {value}, skipDialog: true})`. Экспортированы: `Check, CheckModifier, Modifier, ModifierType, StatisticModifier`.
9. **Урон / Sneak Attack:** `strike.damage(params)` / `strike.critical(params)` — замыкания (pf2e.mjs:39350); `params.options` (массив/Set) ДОХОДИТ до итоговых опций урона (маркер `pf2e-vision:marker` найден в `message.flags.pf2e.context.options`). Sneak Attack — `DamageDice` с predicate `["item:tag:sneak-attack", "target:condition:off-guard"]`, selector `strike-damage` → подмешивание `target:condition:off-guard` в `params.options` его включает. Как перехватывать замыкания (prepareStrike у PC, createDamageRollFunctions у NPC, 25388) — решает кусок E; вызывается урон обычно кнопкой из сообщения атаки (`params.checkContext`).
   Замечание: pf2e сам делает цель off-guard, если у атакующего НАСТОЯЩЕЕ условие hidden (`self:condition:hidden`) — у Занны оно стоит.
10. **Toolbelt API:** `game.toolbelt.api.targetHelper.getMessageTargets(message)` и `setMessageFlagTargets` есть; target-helper в мире ВКЛЮЧЁН.
11. **Удаление флагов:** глобальный `_del` (экземпляр `ForcedDeletion`) — `{flags: {"pf2e-vision": {visibility: {obsId: _del}}}}` удаляет ключ, `{flags: {"pf2e-vision": _del}}` — весь флаг; `updateEmbeddedDocuments("Token", …)` поддерживает. `_replace` — функция.
12. **Форма настроек:** `FormDataExtended.object` оставляет ключи с точками плоскими (`"flat.dc.hidden"`); сохранение через меню «Автоматизация» проверено. Корень шаблона части должен быть ОДНИМ элементом (исправлено в `settings-menu.hbs`).

13. **Трекер боя пропускает участников с `combatant.visible === false`** (`_prepareTrackerContext`, `../pf2e-vision-dev/ref/foundry.mjs:136755`; ядро: `isOwner || !hidden`, pf2e не переопределяет). Обёртка геттера `CONFIG.Combatant.documentClass.prototype.visible` прячет строку у игрока; после смены уровней нужен `ui.combat.render()`. Проверено вживую под Rogue.

14. **Сотворение заклинания:** все 4 класса заклинательства (`SpellcastingEntryPF2e`, `ItemSpellcasting`, `TrickMagicItemEntry`, `RitualSpellcasting`) кончаются `spell.toMessage(null, {mode, data})`; вариант по рангу повторно входит в `toMessage`. Атака заклинанием — `statistic.check.roll` с `dc.slug` защиты. Проверено вживую: «Глухота» Занны по Огру.

## Не проверено (проверять при приёмке кусков)
- Toolbelt auto-cover в мире ВЫКЛЮЧЕН (wall/creature = disabled) — совместимость не проверить без включения.
- `keydown` в окне vs hotbar, цели Seek от игрока (`message.author.targets`) — нужен клиент игрока; проверим при приёмке C/F.
