// E2E coverage for module repair state, the repair task queue, and crew
// shift gating. Drives the real dashboard in a browser via window.game
// (exposed for tests in main.js) rather than re-implementing the logic.
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

test.describe('module repair state', () => {
    test('dashboard loads without console errors and shows full repair panels', async ({ page }) => {
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        page.on('pageerror', err => errors.push(String(err)));

        await startNewGame(page);

        // New Game always starts from _defaultSystems() now (no resuming from a
        // prior save) — all three modules begin at 25% repair, a beat-up salvage
        // ship per the intro backstory, which falls in the "major" band (20-50%).
        await expect(page.locator('#o2-repair-pct')).toHaveText('Repair: 25%');
        await expect(page.locator('#co2-repair-pct')).toHaveText('Repair: 25%');
        await expect(page.locator('#power-repair-pct')).toHaveText('Repair: 25%');
        await expect(page.locator('#o2-repair-btn')).toBeVisible();
        // 25% is part-way up the 20→50 stage: 5/6 of its 5h, then 3h and 2h for the stages above.
        await expect(page.locator('#o2-repair-btn')).toHaveText('Repair to 100% (9.2h)');

        expect(errors).toEqual([]);
    });

    test('repair only decays while the module is switched on', async ({ page }) => {
        await startNewGame(page);

        await page.evaluate(() => {
            window.game.systems.o2.active = false;
            window.game.systems.o2.repairPct = 80;
        });
        await page.evaluate(() => window.game.repairManager.decay(3600)); // 1 game-hour, idle
        let pct = await page.evaluate(() => window.game.systems.o2.repairPct);
        expect(pct).toBe(80);

        await page.evaluate(() => { window.game.systems.o2.active = true; });
        await page.evaluate(() => window.game.repairManager.decay(3600)); // 1 game-hour, running
        pct = await page.evaluate(() => window.game.systems.o2.repairPct);
        expect(pct).toBeCloseTo(80 - 0.14, 5);
    });

    test('a lightly worn module needs only its top stage', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.systems.o2.repairPct = 80; window.game.updateDisplay(); });

        await expect(page.locator('#o2-repair-btn')).toHaveText('Repair to 100% (2h)');
        await page.click('#o2-repair-btn');
        await expect(page.locator('#o2-repair-status')).toContainText('Queued: Tune-up → 100% — 2.0h left');
    });

    test('a wrecked module (<20%) shows the destroy risk of its salvage stage', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.systems.co2.repairPct = 10; window.game.updateDisplay(); });

        // Half of the 6h salvage stage, then 5h + 3h + 2h.
        await expect(page.locator('#co2-repair-btn')).toHaveText('Repair to 100% (13h) — 20% destroy risk');
    });

    test('output follows the stage curve in module_specs.json, interpolated between stage boundaries', async ({ page }) => {
        await startNewGame(page);
        const eff = await page.evaluate(() => [0, 10, 20, 35, 50, 80, 100].map(p => window.game.repairManager.efficiencyAt('o2', p)));
        const expected = [0, 0.05, 0.10, 0.25, 0.40, 0.80, 1];
        eff.forEach((e, i) => expect(e).toBeCloseTo(expected[i], 6));

        // The transceiver has its own, harsher curve.
        const radio = await page.evaluate(() => window.game.repairManager.efficiencyAt('transceiver', 50));
        expect(radio).toBeCloseTo(0.2, 6);
    });

    test('a repair lands in chunks: nothing improves mid-stage, then the module steps up', async ({ page }) => {
        await startNewGame(page);
        const result = await page.evaluate(() => {
            const g = window.game;
            g._stopTimer();
            g.gameTime = 9 * 3600; // on shift
            g.systems.o2.repairPct = 20;
            g.startRepair('o2');   // Rebuild 5h → 50, Overhaul 3h → 80, Tune-up 2h → 100
            const at = () => ({ pct: g.systems.o2.repairPct, band: g.repairQueue[0]?.band, left: g.repairQueue[0]?.hoursRemaining });

            g.repairManager.processQueue(4 * 3600);
            const midStage = at();
            g.repairManager.processQueue(1 * 3600);
            const afterFirst = at();
            // One big tick finishes the second stage and carries on into the third.
            g.repairManager.processQueue(4 * 3600);
            const afterBig = at();
            g.repairManager.processQueue(1 * 3600);
            return { midStage, afterFirst, afterBig, done: { pct: g.systems.o2.repairPct, queue: g.repairQueue.length } };
        });

        expect(result.midStage).toMatchObject({ pct: 20, band: 'Rebuild' });
        expect(result.midStage.left).toBeCloseTo(1, 6);
        expect(result.afterFirst).toMatchObject({ pct: 50, band: 'Overhaul' });
        expect(result.afterBig).toMatchObject({ pct: 80, band: 'Tune-up' });
        expect(result.afterBig.left).toBeCloseTo(1, 6);
        expect(result.done).toEqual({ pct: 100, queue: 0 });
    });

    test('a repair stops at its target, which can be picked on the card and changed in the queue', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game._stopTimer(); window.game.gameTime = 9 * 3600; window.game.updateDisplay(); });

        // Power starts at 25%: targets on offer are the stage tops above that.
        const chips = page.locator('#power-repair-targets .repair-target-chip');
        await expect(chips).toHaveText(['50%', '80%', '100%']);
        await expect(page.locator('#power-repair-targets .chip-active')).toHaveText('100%');

        await chips.filter({ hasText: '50%' }).click();
        await expect(page.locator('#power-repair-btn')).toHaveText('Repair to 50% (5.8h)');
        await expect(page.locator('#power-repair-targets .repair-target-note')).toContainText('Output now 15% of rated');
        await page.click('#power-repair-btn');
        expect(await page.evaluate(() => window.game.repairQueue[0].targetPct)).toBe(50);

        // Raise it to 80% from the queue, then let it run: it stops there, not at 100.
        await page.click('#repair-queue-btn');
        await page.locator('#repair-queue-list .repair-target-chip').filter({ hasText: '80%' }).click();
        const result = await page.evaluate(() => {
            const g = window.game;
            const target = g.repairQueue[0].targetPct;
            g.repairManager.processQueue(12 * 3600);
            return { target, pct: g.systems.power.repairPct, queue: g.repairQueue.length };
        });
        expect(result).toEqual({ target: 80, pct: 80, queue: 0 });
    });

    test('tasks only progress while crew is on shift', async ({ page }) => {
        await startNewGame(page);

        // Off-shift (20:00) — task should stay frozen.
        await page.evaluate(() => {
            window.game.gameTime = 20 * 3600;
            window.game.systems.o2.repairPct = 80;
            window.game.updateDisplay();
        });
        await page.click('#o2-repair-btn');
        await page.evaluate(() => window.game.repairManager.processQueue(300));
        let hours = await page.evaluate(() => window.game.repairQueue[0].hoursRemaining);
        expect(hours).toBe(2);

        // Inside the 9-13 shift — task should progress.
        await page.evaluate(() => { window.game.gameTime = 9.5 * 3600; });
        await page.evaluate(() => window.game.repairManager.processQueue(300));
        hours = await page.evaluate(() => window.game.repairQueue[0].hoursRemaining);
        expect(hours).toBeCloseTo(2 - 300 / 3600, 5);
    });

    test('cancelling removes a queued task', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.systems.o2.repairPct = 80; window.game.updateDisplay(); });
        await page.click('#o2-repair-btn');
        await page.click('#repair-queue-btn');
        await page.click('.task-cancel-btn');
        const len = await page.evaluate(() => window.game.repairQueue.length);
        expect(len).toBe(0);
    });

    test('a successful salvage stage leaves the module jury-rigged until the next stage is done', async ({ page }) => {
        await startNewGame(page);
        const result = await page.evaluate(() => {
            const g = window.game;
            g._stopTimer();
            g.gameTime = 9.5 * 3600;
            g.systems.power.repairPct = 5;
            g.rng.next = () => 0.999; // avoid the 20% destroy roll
            g.startRepair('power');
            g.repairQueue[0].hoursRemaining = 0.0001;
            g.repairManager.processQueue(1);
            delete g.rng.next; // back to the real seeded roll
            const salvaged = { pct: g.systems.power.repairPct, jury: g.systems.power.juryRigged,
                               destroyed: g.systems.power.destroyed, band: g.repairQueue[0].band };

            g.repairQueue[0].hoursRemaining = 0.0001;
            g.repairManager.processQueue(1);
            return { salvaged, rebuilt: { pct: g.systems.power.repairPct, jury: g.systems.power.juryRigged } };
        });
        expect(result.salvaged).toEqual({ pct: 20, jury: true, destroyed: false, band: 'Rebuild' });
        expect(result.rebuilt).toEqual({ pct: 50, jury: false });
    });

    test('degraded power output is displayed to 2dp, not raw floating-point noise', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            // A non-round efficiency multiplier (interpolated between repair stages) is exactly what
            // produced the 16-digit floats this test guards against.
            window.game.systems.power.repairPct = 83;
            window.game.systems.power.active = true;
            window.game.systems.o2.active = true;
            window.game.systems.co2.active = true;
            window.game.systemUpdate.update(1);
            window.game.updateDisplay();
        });

        await expect(page.locator('#power-gen-output')).toHaveText(/^\d+\.\d{2} W$/);
        await expect(page.locator('#power-o2-draw')).toHaveText(/^(0\.00|−\d+\.\d{2}) W$/);
        await expect(page.locator('#power-co2-draw')).toHaveText(/^(0\.00|−\d+\.\d{2}) W$/);
    });

    test('a failed salvage stage destroys the module and disables its toggle', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            window.game.gameTime = 9.5 * 3600;
            window.game.systems.co2.repairPct = 5;
            window.game.rng.next = () => 0; // force the 20% destroy roll
            window.game.startRepair('co2');
            window.game.repairQueue.find(t => t.systemKey === 'co2').hoursRemaining = 0.0001;
            window.game.repairManager.processQueue(1);
            delete window.game.rng.next;
            window.game.updateDisplay();
        });
        const co2 = await page.evaluate(() => window.game.systems.co2);
        expect(co2.destroyed).toBe(true);

        await expect(page.locator('#co2-repair-pct')).toHaveText('DESTROYED');
        await expect(page.locator('#co2-toggle')).toBeDisabled();
    });
});
