// Shared Playwright helpers. New Game now prompts for a save name via a native
// prompt() dialog, so starting a game requires handling that dialog — every
// spec needs this, so it lives here once rather than copied per file.
const base = require('@playwright/test');

// Extends the base `page` fixture so every spec that imports `test` from here
// gets automatic save-slot cleanup for free: any save created during the test
// (any POST /api/saves that succeeds, regardless of which flow triggered it)
// is deleted again once the test finishes. Without this, every `npm test` run
// adds another batch of rows to test-results/test-game.db with nothing ever
// removing them.
const test = base.test.extend({
    page: async ({ page, request }, use) => {
        const createdSaveIds = new Set();
        page.on('response', async response => {
            if (response.request().method() !== 'POST') return;
            if (!response.url().endsWith('/api/saves')) return;
            if (!response.ok()) return;
            try {
                const body = await response.json();
                if (body && typeof body.id === 'number') createdSaveIds.add(body.id);
            } catch { /* not JSON, or body already consumed */ }
        });

        // The first-run tutorial and the contextual tips (tour.js) both put a card
        // over the dashboard that would sit on top of controls specs click — mark
        // the tour as already seen and switch tips off. tests/tour.spec.js opts
        // back in with a later init script that clears the relevant key.
        await page.addInitScript(() => {
            localStorage.setItem('starshipOps.tourSeen', '1');
            localStorage.setItem('starshipOps.tipsOff', '1');
        });

        await use(page);

        await Promise.all(
            [...createdSaveIds].map(id => request.delete(`/api/saves/${id}`).catch(() => {}))
        );
    },
});

// Each call uses a fresh, effectively-unique name (tests share one server/DB for
// the whole run) so creating a save never collides with another test's save.
// New Game now passes through a sector-seed screen (pre-filled with a random
// seed, editable, with a Regenerate button) before the backstory intro —
// accept that with the auto-rolled seed unless a specific one is requested.
async function startNewGame(page, saveName) {
    const name = saveName ?? `Test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    page.once('dialog', d => d.accept(name));
    await page.goto('/');
    await page.click('#new-game-btn');
    await page.waitForSelector('#seed-screen', { state: 'visible' });
    await page.click('#seed-continue-btn');
    await page.click('#intro-continue-btn');
    await page.waitForSelector('#game-container', { state: 'visible' });
    return name;
}

// A new ship's transceiver is too worn to reach anything. Repairs it, switches
// it on and runs one tick, so every charted location and the local market are
// in range — for specs that are about Comms & Nav rather than about fixing it.
async function bringCommsOnline(page) {
    await page.evaluate(() => {
        const g = window.game;
        g.systems.transceiver.repairPct = 100;
        g.systems.transceiver.active    = true;
        g.systemUpdate.update(1);
        g.updateDisplay();
    });
}

module.exports = { test, startNewGame, bringCommsOnline };
