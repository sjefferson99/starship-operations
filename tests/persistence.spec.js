// Coverage for the autosave timer lifecycle. The suite runs against an isolated
// throwaway DB (see playwright.config.js's GAME_DB_PATH), so real saves here never
// touch the developer's actual savegame/game.db.
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

test.describe('autosave', () => {
    test('autosave timer starts on new game and stops on return to menu', async ({ page }) => {
        await startNewGame(page);

        const runningAfterStart = await page.evaluate(() => window.game.autosaveTimer !== null);
        expect(runningAfterStart).toBe(true);

        page.on('dialog', d => d.accept()); // returnToMainMenu() confirms via window.confirm
        await page.evaluate(() => window.game.returnToMainMenu());

        const stoppedAfterMenu = await page.evaluate(() => window.game.autosaveTimer);
        expect(stoppedAfterMenu).toBeNull();
    });

    test('_autosave() saves and shows an "Autosaved" status message', async ({ page }) => {
        await startNewGame(page);

        // Stub the network-touching save so this never writes real files.
        await page.evaluate(() => {
            window.__saveCalls = 0;
            GameState.saveServer = async () => { window.__saveCalls++; };
        });

        // Read the message in the same step: it hides itself after 3 s, which a
        // busy test machine can take between two separate round trips.
        const r = await page.evaluate(async () => {
            await window.game._autosave();
            return { calls: window.__saveCalls, text: document.getElementById('save-status').textContent };
        });
        expect(r.calls).toBe(1);
        expect(r.text).toBe('Autosaved');
    });
});
