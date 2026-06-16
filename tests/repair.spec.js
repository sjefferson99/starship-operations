// E2E coverage for module repair state, the repair task queue, and crew
// shift gating. Drives the real dashboard in a browser via window.game
// (exposed for tests in main.js) rather than re-implementing the logic.
const { test, expect } = require('@playwright/test');

async function startNewGame(page) {
    await page.goto('/');
    await page.click('#new-game-btn');
    await page.click('#intro-continue-btn');
    await page.waitForSelector('#game-container', { state: 'visible' });
}

test.describe('module repair state', () => {
    test('dashboard loads without console errors and shows full repair panels', async ({ page }) => {
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        page.on('pageerror', err => errors.push(String(err)));

        await startNewGame(page);

        await expect(page.locator('#o2-repair-pct')).toHaveText('Repair: 100%');
        await expect(page.locator('#co2-repair-pct')).toHaveText('Repair: 100%');
        await expect(page.locator('#power-repair-pct')).toHaveText('Repair: 100%');
        await expect(page.locator('#o2-repair-btn')).toBeHidden();

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

    test('minor band (50-95%) shows the right label and queues a 3h task', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.systems.o2.repairPct = 80; window.game.updateDisplay(); });

        await expect(page.locator('#o2-repair-btn')).toHaveText('Repair — Minor (3h)');
        await page.click('#o2-repair-btn');
        await expect(page.locator('#o2-repair-status')).toContainText('Queued (minor) — 3.0h left');
    });

    test('replacement band (<20%) shows the destroy-risk label', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { window.game.systems.co2.repairPct = 10; window.game.updateDisplay(); });

        await expect(page.locator('#co2-repair-btn')).toHaveText('Replace (10h, 50% cap, 20% destroy risk)');
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
        expect(hours).toBe(3);

        // Inside the 9-13 shift — task should progress.
        await page.evaluate(() => { window.game.gameTime = 9.5 * 3600; });
        await page.evaluate(() => window.game.repairManager.processQueue(300));
        hours = await page.evaluate(() => window.game.repairQueue[0].hoursRemaining);
        expect(hours).toBeCloseTo(3 - 300 / 3600, 5);
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

    test('successful replacement repair caps at 50% and jury-rigs the module', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            window.game.gameTime = 9.5 * 3600;
            window.game.systems.power.repairPct = 5;
            const original = Math.random;
            Math.random = () => 0.999; // avoid the 20% destroy roll
            window.game.startRepair('power');
            window.game.repairQueue.find(t => t.systemKey === 'power').hoursRemaining = 0.0001;
            window.game.repairManager.processQueue(1);
            Math.random = original;
        });
        const power = await page.evaluate(() => window.game.systems.power);
        expect(power.repairPct).toBe(50);
        expect(power.juryRigged).toBe(true);
        expect(power.destroyed).toBe(false);
    });

    test('degraded power output is displayed to 2dp, not raw floating-point noise', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            // A non-round efficiency multiplier ((repairPct/100)^2) is exactly what
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

    test('failed replacement repair destroys the module and disables its toggle', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => {
            window.game.gameTime = 9.5 * 3600;
            window.game.systems.co2.repairPct = 5;
            const original = Math.random;
            Math.random = () => 0; // force the 20% destroy roll
            window.game.startRepair('co2');
            window.game.repairQueue.find(t => t.systemKey === 'co2').hoursRemaining = 0.0001;
            window.game.repairManager.processQueue(1);
            Math.random = original;
            window.game.updateDisplay();
        });
        const co2 = await page.evaluate(() => window.game.systems.co2);
        expect(co2.destroyed).toBe(true);

        await expect(page.locator('#co2-repair-pct')).toHaveText('DESTROYED');
        await expect(page.locator('#co2-toggle')).toBeDisabled();
    });
});
