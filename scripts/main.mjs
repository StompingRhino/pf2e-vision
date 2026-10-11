import { MODULE_ID } from "./constants.mjs";
import { registerSettings } from "./settings.mjs";
import * as store from "./store.mjs";
import * as matrix from "./matrix-app.mjs";
import * as visuals from "./token-visuals.mjs";
import * as rolls from "./rolls.mjs";
import * as automation from "./automation.mjs";

const pieces = { store, matrix, visuals, rolls, automation };

// One failing piece must not stop the others from loading.
function runAll(phase) {
	for (const [name, piece] of Object.entries(pieces)) {
		try {
			piece[phase]?.();
		} catch (err) {
			console.error(`${MODULE_ID} | ${name}.${phase} failed`, err);
		}
	}
}

Hooks.once("init", () => {
	registerSettings();
	runAll("init");
});

Hooks.once("ready", () => {
	runAll("ready");
	game.modules.get(MODULE_ID).api = { store, visuals, openMatrix: matrix.openMatrix };
});
