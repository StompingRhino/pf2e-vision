# pf2e-vision — план реализации

Foundry v14 (14.360–14.364), pf2e 8.1.2, Workbench 7.3.3, Toolbelt 3.51.1. Кода здесь нет.
Макет «Кисть» — только локально: `prototypes/mockup-brush.dc.html` (ссылка на холст из брифа не работает).

Условные обозначения:
- `pf2e.mjs:N` — строка в `%LOCALAPPDATA%/FoundryVTT/Data/systems/pf2e/pf2e.mjs`.
- Пути `src/...` у Workbench и Toolbelt — файлы внутри их sourcemap (бандлы распакованы из `*.js.map`).
- **[спайк]** — в Foundry не проверить. Список проверок — в разделе 8.

---

## 1. Что выяснено

### 1.1 pf2e сам видимость между токенами не считает

- Hidden, Undetected, Unnoticed и Concealed — обычные условия актёра с `rules: []`. Flat check и off-guard они не дают, текст Concealed — только описание (`lang/en.json:6862`).
- Условие глобально для актёра. Roll options вида `self:condition:hidden` кладёт `pf2e.mjs:50411`, в броске это `target:condition:hidden`.
- Единственная автоматика — зрение на канвасе: DetectionMode `basicSight`, `lightPerception`, `hearing`, `feelTremor` (`pf2e.mjs:61242-61320`) прячут такого токена от всех сразу.
- Вывод: **настоящие условия на актёров не ставим** — это сломает направленность.
- Хука «перед броском» в pf2e нет. Есть только `pf2e.damageRoll`, `pf2e.reroll`, `pf2e.preReroll` (`23299`, `24428`).
- `game.pf2e` экспортирует `Check`, `CheckModifier`, `ConditionManager`, `actions`, `RuleElements` и др. (`70762-70800`). `Statistic` и `DegreeOfSuccess` не экспортируются.

### 1.2 Последствия уровней и их направление

Состояние хранится как «цель T, наблюдатель O → level»: **как O видит T**. Читаем через `getLevel(T, O)`.

Для атаки атакующего A по цели T:
- **Чистая проверка делает A**, уровень = `getLevel(T, A)` (T спрятан от A).
- **Off-guard получает T**, если уровень = `getLevel(A, T)` ∈ {hidden, undetected, unnoticed}. Правило: существо, от которого ты спрятан, застигнуто тобой врасплох (`pf2e.mjs:52156`).

| Уровень (как O видит T) | Чистая проверка у O при атаке T | O застигнут врасплох для атак T |
|---|---|---|
| observed | нет | нет |
| concealed | СЛ 5 | нет |
| hidden | СЛ 11 | да |
| undetected | СЛ 11 (нужно угадать клетку) | да |
| unnoticed | как undetected (+ T не знает о присутствии, только пометка) | да |

СЛ редактируются в настройках (раздел 6).

Подсказка в ячейке называет обе стороны, например: «Валерос → Огр: чистая проверка СЛ 11; Валерос застигнут врасплох для атак Огра».

### 1.3 Как подать состояние в бросок атаки: обёртка `game.pf2e.Check.roll`

libWrapper, режим `WRAPPER`, регистрация в `ready`.
Образец — Toolbelt `src/tools/auto-cover/tool.ts` (`#wrappers` стр. 57-63, `#checkRoll`, `#addCoverSourceToContext` стр. ~349, 468-477).

Фильтр: `context.type === "attack-roll"` (сюда входят удары и атаки заклинаниями), есть `context.target`, нет `isReroll`, `createMessage`.

В обёртке делаем:
1. Токены: `context.origin.token ?? context.token`, `context.target.token`. Бой — тот, где состоят оба токена (`token.combatant?.parent`), **не** `game.combat`.
2. **Чистая проверка** (если включена и атакующий подходит под настройку «чьи атаки»): бросаем её от имени A, СЛ из настроек по уровню `getLevel(T, A)`. Провал — по настройке:
   - `miss` (по умолчанию): добавляем в `context.dosAdjustments` запись `{ adjustments: { success: {label, amount: "failure"}, criticalSuccess: {label, amount: "failure"} } }`.
     - Это `DEGREE_ADJUSTMENT_AMOUNTS.TO_FAILURE` (`pf2e.mjs:369-375`); `Check.roll` применяет такие записи при расчёте степени успеха (`24241-24248`). Если `context.dosAdjustments` не задан — создать массив.
     - `label` («Чистая проверка не пройдена: цель Спрятанность») pf2e покажет в сообщении об атаке. Атака становится промахом, сообщение создаётся, Workbench авто-урон не запускает (он стреляет только при попадании).
   - `warn`: только сообщение в чат, бросок идёт как есть.
   - `cancel`: `return null`.
3. **Off-guard на попадание** (если включено): уровень `getLevel(A, T)` ∈ {hidden, undetected, unnoticed}.
   - Клон `context.target.actor.clone({ items: [...context.target.actor._source.items, offGuardSource] }, { keepId: true })`, где `offGuardSource = game.pf2e.ConditionManager.getCondition("off-guard", {name}).toObject()` — так pf2e делает фланкинг (`pf2e.mjs:20268`).
   - Клонировать от **текущего** `context.target.actor`, чтобы не потерять cover Toolbelt.
   - Обновить `context.dc.value` и `context.dc.statistic` по `context.dc.slug` (как auto-cover).
   - Добавить в `context.options` `target:condition:off-guard`, если его там нет.
4. Roll options для предикатов GM: `pf2e-vision:target:<level>` (как A видит T), `pf2e-vision:origin:<level>`.
5. Всё в `try/catch`: при ошибке вызвать `wrapped(...args)` как есть и `console.warn`.

Почему так: другие пути недоступны. Rule Element `EphemeralEffect` берёт данные с актёра, без токен-контекста (`pf2e.mjs:43041`, `47957`). `RollContext` не экспортируется. Хука нет.

### 1.4 Off-guard → урон (Sneak Attack, precision)

Урон считается отдельным `DamageContext` (`pf2e.mjs:24922-24940`). Опции attack-броска (`context.options`) в него **не** переходят.
- Из check-контекста `DamageContext` берёт только подстановки (`substitutions`, `24928`).
- Цель в нём — реальный актёр токена, без нашего off-guard.

Что подтверждено в коде:
- Урон читает опции из Set, который строится из `params.options` (`25399-25405`, `39352-39368`). Туда же идёт `baseOptions`.
- `target:condition:off-guard` в этом Set срабатывает у backstabber (`pf2e.mjs:24723`) и у предикатов Sneak Attack-подобных правил.

Точка вмешательства — аргумент `params.options` у функций урона `strike.damage(params)` и `strike.critical(params)`. Цель берётся как `params.target ?? game.user.targets.first()`; её же берём и мы.

Где эти функции создаются (замыкания в данных актёра, прототип не обернуть):
- PC: `CharacterPF2e#prepareStrike` (`39121`; урон `39346+`).
- NPC и прочие удары: `createDamageRollFunctions` (`25388`, вызовы `25307`, `25378`, `39111`).
- Заклинания: `SpellPF2e#damage` и `ElementalBlast#damage` (`28952`) — обычные методы прототипа, оборачиваются libWrapper.

Способ [спайк]: после `prepareStrike` (libWrapper на прототип PC, для NPC — на подготовку ударов актёра) подменить `strike.damage` и `strike.critical` обёртками, которые добавляют в `params.options` значение `target:condition:off-guard` — если выполнено условие off-guard по уровню `getLevel(A, T)` и включена настройка «off-guard на урон».
- Проверить: как обернуть удары NPC (`#prepareStrikes`, `46768`, приватный), и срабатывает ли Sneak Attack при добавленной опции.
- Если замыкания не обернуть чисто, запасной путь — обёртка `DamagePF2e.roll`, если класс достижим.
- Если ничто из этого не работает — пункт остаётся в v1 только для заклинаний, а для ударов это записывается в спорные.

### 1.5 Workbench и Toolbelt

**Автоматики Stealth/Hide/Sneak/Seek и видимости нет ни в одном.**

Workbench:
- Hide/Seek/Sneak — лишь пункты меню `src/module/feature/macros/basicActionMacros.ts` (стр. ~467, 594, 622 вызывают `game.pf2e.actions.get(...)`).
- Его проверка чистых проверок (`src/module/feature/damageHandler/index.ts:128`, `noOrSuccessfulFlatcheck`) работает только вместе с модулем `pf2-flat-check`, которого нет. Без него Workbench бросает авто-урон при любом попадании — поэтому провал чистой проверки делаем промахом.
- Хуки Workbench на наши флаги не реагируют.

Toolbelt:
- Требует `lib-wrapper` — прописываем его и у себя.
- `auto-cover` обёртывает `Check.roll` и `Token._refreshVisibility` тем же способом. Конфликта с нашей обёрткой нет, если клонировать от текущего `context.target.actor`.
- Целей Seek можно брать через `game.toolbelt.api.targetHelper.getMessageTargets(message)` (`foundry-helpers/src/module.ts:51,80`, `src/main.ts:60`; `src/tools/target-helper/tool/tool.ts:152-180`). Настройка `targetHelper.enabled` по умолчанию **выключена**, проверять через `game.toolbelt.getToolSetting("targetHelper","enabled")`.
- Для кнопок в чат-карточке образец хука — `renderChatMessageHTML` (Toolbelt `better-chat/tool.ts:22,26`).

`requires` по требованию пользователя: `xdy-pf2e-workbench`, `pf2e-toolbelt`, плюс `lib-wrapper`. Код должен переживать их отсутствие (`game.modules.get(id)?.active`).

### 1.6 Видимость токена у игрока

Основной путь: libWrapper на геттер `CONFIG.Token.objectClass.prototype.isVisible` (`WRAPPER`). Для скрываемого токена возвращаем `false`.
- Установка `token.visible = false` в `refreshToken`, скорее всего, меш не прячет: меш лежит в `canvas.primary`.
- Конфликта с Toolbelt (`_refreshVisibility`) нет: `auto-cover/tool.ts:58-63`, `283-289`. pf2e переопределяет `TokenPF2e._refreshVisibility` (`pf2e.mjs:32261`) — вызывать `wrapped()`.
- Запасной путь, если геттер не оборачивается: `refreshToken` + `token.mesh.visible = false`.
- Прозрачность идемпотентно: `mesh.alpha = Math.min(mesh.alpha, document.alpha * factor)` в `refreshToken` при `flags.refreshState`. Никаких `*=`.
- Принудительное обновление: `token.renderFlags.set({ refreshState: true, refreshVisibility: true })`.
- Тот, кто скрыт, не должен реагировать на наведение и выбор в цель — проверка в спайке.
- Остаётся видно: свет и зрение скрытого токена, его имя в трекере боя, положение в данных сцены. Это косметика на клиенте. Настоящий секрет — `hidden: true` у токена.
- GM токены не скрываются; для GM — индикаторы относительно выделенных токенов (настройка).

### 1.7 Хранение

Флаг на токене-цели: `flags.pf2e-vision.visibility = { [observerTokenId]: level }`; отсутствие ключа = observed.
Combat-флаг отвергнут: `EncounterPF2e._onUpdate` (`pf2e.mjs:31197`) на любой апдейт вызывает `resetActors` на всех клиентах.

- Запись: один `scene.updateEmbeddedDocuments("Token", [...])` на мазок или строку; удаление ключей — `_del`, как в pf2e 8.1.2 (`pf2e.mjs:27542`, `55074`), а не `-=`.
- Бой: **активный бой сцены** (`combat.active && combat.scene === canvas.scene`); в броске — бой, где состоят оба токена. Не `game.combat`: это просматриваемый бой.
- Очистка (настройка `cleanup.onCombatEnd`): один GM-хук `deleteCombat` (только `game.users.activeGM`) собирает токены комбатантов и делает один `updateEmbeddedDocuments`. Дополнительно `deleteCombatant` чистит флаг у ушедшего токена. Висячие ключи наблюдателей, чьи токены удалены, игнорируются при чтении и вычищаются при следующей записи.

---

## 2. Структура файлов

Без сборщиков и npm.

```
module.json
scripts/
  main.mjs            вход: init/ready/хуки, подключение остальных
  constants.mjs       ID, LEVELS, цвета, иконки, ключи настроек и их значения по умолчанию
  logic.mjs           ЧИСТАЯ логика, без глобалов Foundry
  store.mjs           чтение/запись флагов, кэш, обратный дифф для «Отмены», очистка
  settings.mjs        game.settings.register + registerMenu; форма «Автоматизация» (ApplicationV2)
  matrix-app.mjs      окно-матрица, кисть, клавиши 1–5, подсказки
  token-visuals.mjs   видимость токенов у игрока/GM, подсветка (имя файла не `canvas`, чтобы не затенять глобал)
  rolls.mjs           обёртка Check.roll + обёртки урона (разделы 1.3–1.4)
  automation.mjs      Hide/Sneak/Seek: карточка предложения
templates/  matrix.hbs  suggest.hbs  settings-menu.hbs
styles/pf2e-vision.css
lang/en.json  lang/ru.json
tests/logic.test.mjs      node --test
```

`logic.mjs` содержит:
- таблицу последствий (раздел 1.2) с СЛ из переданных настроек;
- построение diff-обновлений флагов (`_del` вместо значения для observed);
- «самый видимый» уровень из набора;
- обратный дифф для отмены;
- переходы Hide/Sneak/Seek и степень успеха (±10, сдвиг на нат. 20/1).

Контракты между кусками (задаёт A, остальные не меняют):
- `store`: `getLevel(targetTokenId, observerTokenId)`, `getCombatTokens()`, `applyChanges([{observerId, targetId, level}])` (один `update`, возвращает обратный дифф), `revert(diff)`, `onChange(fn)`.
- `token-visuals`: `highlight([{tokenId, role:"observer"|"target"}])`, `refreshAll()`.
- `settings.mjs`: `getSetting(key)` — единственное место чтения настроек.

---

## 3. Компоненты

### 3.1 Окно-матрица (`matrix-app.mjs`, `matrix.hbs`, css)

База — proto-1 и логика `renderVals` макета: палитра из 5 кистей + «Отмена»; строки — наблюдатели, столбцы — цели; клик по имени заливает строку/столбец; ячейка — цветная плашка с иконкой и коротким названием; диагональ — пустая.

- `ApplicationV2` + `HandlebarsApplicationMixin`, `actions` для кисти, строки, столбца, отмены, союзников.
- Протяжка: `pointerdown` по ячейке, `pointerenter` при зажатой кнопке, `pointerup/pointercancel` на `window`. Во время мазка окно не перерисовывается (локально красим DOM). На `pointerup` — один `store.applyChanges`.
- «Отмена»: обратный дифф только затронутых ячеек последнего действия; небольшой стек (до 10), без настройки.
- Источник участников — активный бой сцены (1.7), комбатанты с токенами на этой сцене. Дебаунс перерисовки при `createCombatant`, `deleteCombatant`, `updateCombatant`, `updateCombat`, `deleteCombat`, `updateToken` с нашим флагом.
- Кнопка открытия — **только** в шапке трекера боя: хук `renderCombatTracker` (`html` — HTMLElement), вставка в `nav`/`header`. DOM трекера v14 — [спайк]. GM-only.
- Иконки — `systems/pf2e/icons/conditions/{observed,concealed,hidden,undetected,unnoticed}.webp` (все 5 существуют). Цвета из брифа: observed `#2b2830`, concealed `#8fb8d4`, hidden `#e3a23b`, undetected `#b8483a`, unnoticed `#5a3d8c`.
- Шрифты: `var(--sans-serif)` для текста, `var(--serif)` (Eczar) для заголовков. У Eczar нет кириллицы — русские заголовки через запасной шрифт; указать fallback в `font-family`. Google Fonts не подключать.
- **Горячие клавиши 1–5** — не `game.keybindings`, а `keydown` на корневом элементе окна (`tabindex="-1"`, `stopPropagation` + `preventDefault`), срабатывает только при фокусе внутри окна и если включена клиентская настройка. Hotbar ядра по этим цифрам не трогаем. Поля ввода в окне нет, но обработчик всё равно игнорирует `input/textarea`.
- **Подсказка последствий** (если включена): через `data-tooltip` из `logic.consequences(level, cfg)`, формат — раздел 1.2, обе стороны. Показывает только то, что включено в настройках (например, без строки про off-guard, если он выключен).
- **Спасброски**: в подсказке для concealed/hidden — приписка «против эффектов и спасбросков чистая проверка бросается вручную» (в v1 модуль их не автоматизирует).
- **Союзники**: переключатель в шапке окна; значение по умолчанию — клиентская настройка. Свёрнутые ячейки (PC↔PC и NPC↔NPC) показываются приглушённой заглушкой; данные остаются; заливка строки/столбца и мазок их пропускают. Критерий — настройка `matrix.allyCriterion`: `alliance` (`ActorPF2e#alliance`, `pf2e.mjs:36290`) или `owner` (`actor.hasPlayerOwner`).
- Подсветка на канвасе: при наведении на имя строки/столбца или ячейку вызывается `token-visuals.highlight`. Работоспособность подсветки проверяется в этом куске (C).

### 3.2 Подсветка и визуал (`token-visuals.mjs`)

- Подсветка по образцу proto-3 `#highlightToken`: `PIXI.Graphics` рамкой на `canvas.interface`; observer и target разными цветами. Если `PIXI.Graphics#lineStyle` недоступен (PIXI 8) — `rect().stroke()`; проверка версии в спайке. Снимается при `mouseleave`, закрытии окна, смене сцены. Включается клиентской настройкой.
- Визуал у игрока: `effectiveLevel(token)` — самый видимый среди **владеемых токенов игрока, состоящих в том же бою, что и целевой токен** (`o.document.isOwner`, `o.document.combatant?.parent === token.document.combatant?.parent`); сам токен и свои токены пропускаются.
  - concealed — прозрачность `visual.concealedOpacity`, hidden — `visual.hiddenOpacity`; undetected/unnoticed — скрыт (если `visual.hideUndetected`); значок по `visual.badge`.
  - Значок — `PIXI.Sprite` из иконки системы, дочерний к токену, с именем для поиска (идемпотентно, учитывать гонку загрузки текстуры, как в proto-3).
- GM: токены не скрываются; значок относительно выделенных токенов (настройка `visual.gmIndicators`, client).
- Перерисовка: `store.onChange`, `controlToken`, `canvasReady`, `createToken`/`deleteToken`. В хуках — кэш уровней, перестраиваемый на изменение.

### 3.3 Броски (`rolls.mjs`)

Разделы 1.3 и 1.4. Каждая точка читает свои настройки (раздел 6): `flat.enabled`, `flat.dc.*`, `flat.onFail`, `flat.who`, `offguard.attack`, `offguard.damage`.
- Только броски атаки (удары и атаки заклинаний). Спасброски — нет.
- Слово «перебросы» в плане исключено: `rerollFromMessage` не идёт через `Check.roll`.
- Диалог проверки с подписью «Цель: Спрятанность» — не в v1.

### 3.4 Автоматика Hide/Sneak/Seek (`automation.mjs`, `suggest.hbs`)

- `createChatMessage`, только на клиенте `game.users.activeGM`.
- Распознавание: `message.flags.pf2e.context.options` содержит `action:hide`, `action:sneak` или `action:seek` (pf2e кладёт их в `hide()` `pf2e.mjs:70224`, `seek()` `67881`, `sneak()` `70260`); `context.type === "skill-check"`.
- Бросок: `message.rolls[0].total`; натуральный d20 — из `flags.pf2e.context.contextualOptions.postRoll`, опция `check:roll:total:natural:N`.
- DC: `observer.actor.perception.dc.value` (Hide/Sneak), `target.actor.skills.stealth.dc.value` (Seek).
- Режим для каждого действия отдельно: `off` / `suggest` (по умолчанию) / `auto`.
  - `suggest` — whisper-карточка GM: строка на наблюдателя (СЛ, степень, было → станет, галочка) и кнопка «Применить» (выбранные строки одним `store.applyChanges`). Хук — `renderChatMessageHTML`.
  - `auto` — применяет сразу и пишет GM краткую сводку.
- Правила переходов (из `systems/pf2e/lang/action-en.json`, `PF2E.Actions.Hide|Sneak|Seek.Notes`). Unnoticed обрабатывается как undetected.

| Действие | Применяется к | Результат |
|---|---|---|
| Hide | observed, concealed | успех или крит. успех → hidden |
| Hide | hidden, undetected | сохраняют уровень |
| Sneak | hidden, undetected, unnoticed | успех → undetected; провал → hidden; крит. провал → observed |
| Sneak | observed, concealed | без изменений |
| Seek | hidden, undetected, unnoticed (для искателя) | успех: undetected → hidden, hidden → observed; крит. успех → observed; провал без изменений |

- Кого считать наблюдателями (Hide/Sneak) — настройка `auto.observers`: `enemies` (по `alliance`, по умолчанию) или `all`.
- Цели Seek: `message.author.targets` или `message.flags.pf2e.context.target`; при включённом target-helper — `getMessageTargets(message)`. **Не** `game.user.targets` (это цели GM на его клиенте). Если целей нет — все скрытые от искателя токены боя.
- Правила укрытия, света и области модуль не считает (по брифу) — GM правит матрицу вручную.

### 3.5 Локализация

- `lang/en.json`, `lang/ru.json`; не зависим от `pf2ru-translation`. Свои ключи, корень `PF2EVISION`.
- Термины (русские значения — из pf2ru-translation, проверены в `generated/lang/ru.json`; копируются в наш `ru.json`):

| ключ | en | ru |
|---|---|---|
| level.observed | Observed | Видимость |
| level.concealed | Concealed | Плохая видимость |
| level.hidden | Hidden | Спрятанность |
| level.undetected | Undetected | Необнаруженность |
| level.unnoticed | Unnoticed | Незамеченность |
| offGuard | Off-Guard | Застигнут врасплох |
| flatCheck | Flat Check | Чистая проверка |
| action.hide | Hide | Спрятаться |
| action.seek | Seek | Поиск |
| action.sneak | Sneak | Красться |
| stealth | Stealth | Скрытность |
| perception | Perception | Внимание |

- Короткие подписи плашек: ru «Вид., Плох., Спр., Необн., Незам.», en «Obs., Conc., Hid., Undet., Unnot.».
- **Все ключи (UI, настройки, подсказки, карточки) регистрирует заранее кусок A** — остальные исполнители только читают. Нужен новый ключ — сообщить в G.

---

## 4. Порядок реализации

| # | Кусок | Файлы (владелец) | Зависит от | Проверка |
|---|---|---|---|---|
| S | Спайк (раздел 8) | временные макросы | — | чек-лист раздела 8 |
| A | Каркас, логика, настройки, lang | `module.json`, `main.mjs`, `constants.mjs`, `logic.mjs`, `settings.mjs`, `templates/settings-menu.hbs`, `lang/*.json`, `tests/logic.test.mjs`, стабы остальных `*.mjs` | — | `node --test tests/`, `node --check scripts/*.mjs` |
| B | Хранение | `store.mjs` | A | в Foundry: запись/чтение флагов, отмена, очистка при `deleteCombat` |
| C | Матрица | `matrix-app.mjs`, `matrix.hbs`, `pf2e-vision.css` | A, B, D (подсветка) | в Foundry: кисть, протяжка, строка/столбец, отмена, союзники, клавиши 1–5, подсказки, **подсветка** |
| D | Визуал | `token-visuals.mjs` | A, B | два клиента: уровни, несколько токенов, смена боя |
| E | Броски | `rolls.mjs` | A, B | атака по цели на каждом уровне; провал → промах с пометкой; off-guard меняет СЛ; Sneak Attack получает off-guard; Toolbelt auto-cover вкл/выкл; Workbench авто-урон |
| F | Автоматика | `automation.mjs`, `suggest.hbs` | A, B | Hide/Sneak/Seek от PC и NPC, все три режима |
| G | Интеграция | `main.mjs` (финальный), слияние lang | всё | сценарий ниже |

C, D, E, F параллельно после A и B. Файлы не пересекаются: `lang/*` и `settings.mjs` целиком у A.

Без Foundry проверяются только `node --test` и `node --check`. Всё остальное — только в запущенном Foundry; исполнитель обязан указать в отчёте, что не запускал.

Тесты `logic.test.mjs` покрывают значения настроек: СЛ из настроек (5/11 и изменённые), режим по каждому действию (`off`/`suggest`/`auto`), `flat.who`, `flat.onFail`, критерий союзников, все ячейки таблицы переходов Hide/Sneak/Seek (включая «Sneak из observed/concealed без изменений»), степень успеха на границах ±10 и нат. 20/1, направление off-guard (`getLevel(A, T)`) и чистой проверки (`getLevel(T, A)`).

### Сценарий приёмки (G)

1. Бой: 2 PC от разных игроков, 2 NPC.
2. GM: матрица из трекера; кисть «Спрятанность», протяжка NPC → PC.
3. У игроков токены скрыты/потускнели каждому по своим токенам; скрытый токен нельзя навести и выбрать целью.
4. Атака PC по NPC, который от него спрятан (`getLevel(NPC, PC)` = hidden): чистая проверка СЛ 11, провал → промах с пометкой. Атака NPC, спрятанного от PC, по PC: PC застигнут врасплох (СЛ у PC ниже на 2, Sneak Attack у NPC работает).
5. Hide от PC: у GM карточка «Применить»; значки обновляются.
6. Конец боя: флаги токенов удалены одним обновлением.

---

## 5. Настройки (регистрирует и читает через `getSetting` кусок A)

Группировка: простые — в стандартном списке; «Автоматизация» — одним окном `registerMenu` (ApplicationV2-форма `settings-menu.hbs`), поля пишут в те же ключи. Каждая точка автоматики читает свою настройку (колонка «Реализует»).

**Окно «Автоматизация»** (все world, реализует форму A):

| Ключ | Тип | По умолчанию | Влияет на | Реализует |
|---|---|---|---|---|
| `auto.hide` | `off`/`suggest`/`auto` | `suggest` | реакция на Hide | F |
| `auto.sneak` | то же | `suggest` | реакция на Sneak | F |
| `auto.seek` | то же | `suggest` | реакция на Seek | F |
| `auto.observers` | `enemies`/`all` | `enemies` | кого проверять при Hide/Sneak | F |
| `flat.enabled` | bool | да | чистая проверка при атаке | E |
| `flat.dc.concealed` | число | 5 | СЛ при concealed | E |
| `flat.dc.hidden` | число | 11 | СЛ при hidden | E |
| `flat.dc.undetected` | число | 11 | СЛ при undetected и unnoticed | E |
| `flat.onFail` | `miss`/`warn`/`cancel` | `miss` | исход провала чистой проверки | E |
| `flat.who` | `all`/`pc`/`npc` | `all` | чьи атаки проверять | E |
| `offguard.attack` | bool | да | off-guard при расчёте попадания | E |
| `offguard.damage` | bool | да | off-guard в урон (Sneak Attack, precision) | E |
| `cleanup.onCombatEnd` | bool | да | чистка флагов в `deleteCombat` | B |

**Стандартный список — world:**

| Ключ | Тип | По умолчанию | Влияет на | Реализует |
|---|---|---|---|---|
| `visual.concealedOpacity` | число 0–1 | 0.8 | прозрачность concealed у игроков | D |
| `visual.hiddenOpacity` | число 0–1 | 0.45 | прозрачность hidden у игроков | D |
| `visual.hideUndetected` | bool | да | скрывать undetected/unnoticed от игроков | D |
| `flat.spells` | bool | да | чистая проверка по целям для заклинаний без атаки (только сообщение) | B |
| `visual.hideInTracker` | bool | нет | скрывать в трекере боя участников, необнаруженных для всех токенов игрока | D |
| `visual.badge` | bool | да | значок состояния у игроков | D |

**Стандартный список — client:**

| Ключ | Тип | По умолчанию | Влияет на | Реализует |
|---|---|---|---|---|
| `visual.gmIndicators` | bool | да | значки у GM относительно выделенных токенов | D |
| `matrix.collapseAllies` | bool | нет | союзники свёрнуты при открытии окна | C |
| `matrix.allyCriterion` | `alliance`/`owner` | `alliance` | что считать союзниками | C |
| `matrix.hotkeys` | bool | да | клавиши 1–5 в окне | C |
| `matrix.tooltip` | bool | да | подсказка последствий | C |
| `matrix.highlight` | bool | да | подсветка токенов на канвасе | D |

Убрано как бессмысленное: настройка глубины отмены, второе место кнопки открытия, скрытие необнаруженных в трекере.

---

## 6. `module.json`

`id: "pf2e-vision"`, `compatibility: {minimum: "14", verified: "14.364"}`, система pf2e ≥ 8.1.0.
`requires`: `xdy-pf2e-workbench`, `pf2e-toolbelt`, `lib-wrapper`. `esmodules: ["scripts/main.mjs"]`, `styles`, `languages` (en, ru).

---

## 7. Риски

- Обёртка `Check.roll` и подмена функций урона — «внутренние» точки pf2e; при крупном обновлении могут сломаться. Защита: `try/catch` с откатом на `wrapped(...)`.
- Скрытие на клиенте — косметика, не защита.
- Размер матрицы при 10+ участниках растёт квадратично; смягчают сворачивание союзников и `min-width: 0` с обрезкой имён.
- Не проверено: ядро Foundry v14 (локально нет), запуск прототипов, любые участки, помеченные [спайк].

---

## 8. Спайк (в живом Foundry, ~15 минут)

1. `PIXI.VERSION`; есть ли `Graphics.prototype.lineStyle`.
2. Скрытие: libWrapper на геттер `Token.prototype.isVisible` (поддерживает ли геттеры). У игрока арт токена исчез, **наведение и выбор в цель не работают**. Запасной путь: `refreshToken` + `mesh.visible=false`. Alpha `Math.min(...)` не накапливается при повторных `refreshState` и анимации.
3. DOM шапки трекера боя v14 и хук `renderCombatTracker`.
4. `keydown` на элементе окна с `stopPropagation` не конфликтует с hotbar; работает при фокусе.
5. Обёртка `game.pf2e.Check.roll`: `context.target.token`/`origin.token` — `TokenDocument`; клон цели с off-guard и пересчёт `context.dc.value`/`statistic`; `dosAdjustments` с `success`/`criticalSuccess` → `"failure"` даёт промах и показывает `label`; начальное значение `context.dosAdjustments`.
6. Как бросить чистую проверку: `actor.perception.constructor` как `Statistic` с `check:{type:"flat-check"}` (`pf2e.mjs:33169`) или `Check.roll(new game.pf2e.CheckModifier("flat-check", …), {type:"flat-check", …})`; вернуть `Roll`, прочитать `total`.
7. Урон: чистый способ обернуть `strike.damage`/`critical` у PC (`prepareStrike` `39121`) и NPC (`createDamageRollFunctions` `25388`, `#prepareStrikes` `46768`); `SpellPF2e#damage`; срабатывает ли Sneak Attack при добавленном `target:condition:off-guard` в `params.options`.
8. Seek: цели из `message.author.targets` и `flags.pf2e.context.target`.
9. `game.toolbelt.api.targetHelper` существует.
10. `_del` как значение в `updateEmbeddedDocuments` удаляет ключ флага токена.
11. Совместная работа с включённым auto-cover Toolbelt.

---

## 9. Спорные места

Решённых пользователем вопросов здесь нет (режим автоматики, исход чистой проверки, off-guard в урон, хранение, `requires`, горячие клавиши, настройки). Заметно пользователю и ещё не решено:

1. **Видимость у игрока при нескольких токенах.** Варианты: самый видимый из своих токенов боя (рекомендую, по брифу) / только выделенный. Причина: игрок часто ничего не выделяет.
2. **Off-guard в урон для ударов.** Если замыкания `strike.damage` нельзя обернуть чисто (спайк, п. 7), в v1 это будет работать только для заклинаний. Тогда решение: оставить так / обернуть `DamagePF2e.roll`, если доступно.
3. **Синхронизация с настоящими условиями pf2e.** Не синхронизируем: реальное условие hidden/undetected прячет токена от всех (`pf2e.mjs:61245`) и сложится с нашим. Рекомендую так и оставить; пользователю достаточно знать об этом.
