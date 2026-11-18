// E2E coverage for the first-run guided tour (tour.js) and the header's
// current-location readout. The shared `page` fixture marks the tour as
// already seen so it stays out of every other spec's way; these tests clear
// that flag again to get the real first-time-player experience.
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

const showTour = page => page.addInitScript(() => localStorage.removeItem('starshipOps.tourSeen'));

test.describe('header location', () => {
    test('shows the current location name and type', async ({ page }) => {
        await startNewGame(page);
        await expect(page.locator('#location-name')).toHaveText('Harlow\'s Salvage');
        await expect(page.locator('#location-type')).toHaveText('Kel Veth III · Planet · Salvage yard · Breathable atmosphere');
    });

    test('follows the ship to the port, and in flight', async ({ page }) => {
        await startNewGame(page);
        await page.evaluate(() => { const g = window.game; g.flight = { to: 'port', hoursLeft: 0.2, totalHours: 0.3 }; g.updateDisplay(); });
        await expect(page.locator('#location-name')).toHaveText('In flight to Port Carrow');
        await expect(page.locator('body')).toHaveAttribute('data-bg', 'flight');
        await page.evaluate(() => { const g = window.game; g.flight = null; g.berth = 'port'; g.updateDisplay(); });
        await expect(page.locator('#location-name')).toHaveText('Port Carrow');
        await expect(page.locator('#location-type')).toHaveText('Kel Veth III · Planet · Spaceport · Breathable atmosphere');
        await expect(page.locator('body')).toHaveAttribute('data-bg', 'port');
    });
});

test.describe('guided tour', () => {
    test('does not auto-start once it has been seen', async ({ page }) => {
        await startNewGame(page);
        await expect(page.locator('#tour-card')).toBeHidden();
    });

    test('walks a first-time player through vents, rationing, repairs and shifts', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(String(err)));
        await showTour(page);
        await startNewGame(page);

        const title = page.locator('#tour-title');
        await expect(title).toHaveText('Welcome aboard, Captain');
        await page.click('#tour-next-btn');
        await expect(title).toHaveText('Where you are');
        await page.click('#tour-next-btn');
        await expect(title).toHaveText('Her drives are scrap');
        await expect(page.locator('#tour-body')).toContainText('Storage Box 2 is empty');
        await page.click('#tour-next-btn');

        // Action steps have no Next button — they advance on the real control.
        await expect(title).toHaveText('Open the vents');
        await expect(page.locator('#tour-next-btn')).toBeHidden();
        await page.click('#vent-toggle');

        await expect(title).toHaveText('Ration the water');
        await page.click('#water-ration-toggle');

        await expect(title).toHaveText('Food');
        await page.click('#tour-next-btn');

        await expect(title).toHaveText('No power, no systems');
        await page.click('#tour-next-btn');

        // The tour steers the player to a partial repair: pick 50%, then order it.
        await expect(title).toHaveText('Repair the transceiver first');
        await page.locator('#transceiver-repair-targets .repair-target-chip').filter({ hasText: '50%' }).click();

        await expect(title).toHaveText('Order the repair');
        await expect(page.locator('#transceiver-repair-btn')).toHaveText('Repair to 50% (2.5h)');
        await page.click('#transceiver-repair-btn');
        expect(await page.evaluate(() => window.game.repairQueue[0].targetPct)).toBe(50);

        await expect(title).toHaveText('The Work Queue');
        await page.click('#repair-queue-btn');

        await expect(title).toHaveText('Queue the generator next');
        await page.click('.repair-available-btn[data-system-key="power"]');

        await expect(title).toHaveText('Queue order is priority');
        await page.click('#tour-next-btn');
        await expect(title).toHaveText('On shift, off shift');
        await expect(page.locator('#repair-crew-status')).toContainText('Engineering on duty: 0/1');
        await page.click('#tour-next-btn');

        // Moving on closes the queue overlay so the header's Crew stat is reachable.
        await expect(title).toHaveText('Your crew');
        await expect(page.locator('#task-queue-screen')).toBeHidden();
        await page.click('#crew-stat');

        await expect(title).toHaveText('Setting shifts');
        await page.click('.crew-edit-btn');
        await page.click('.shift-add-btn');
        await page.click('.shift-save-btn');
        await page.click('#tour-next-btn');

        await expect(title).toHaveText('Passing the time');
        await page.click('#tour-next-btn'); // "Finish"
        await expect(page.locator('#tour-card')).toBeHidden();

        const state = await page.evaluate(() => ({
            ventsOpen: window.game.ventsOpen,
            rationing: window.game.systems.freshWater.rationing,
            queue:     window.game.repairQueue.map(t => t.systemKey),
            onShift:   window.game.repairManager.crewOnShift().length,
            seen:      localStorage.getItem('starshipOps.tourSeen'),
        }));
        expect(state).toEqual({ ventsOpen: true, rationing: true, queue: ['transceiver', 'power'], onShift: 1, seen: '1' });
        expect(errors).toEqual([]);
    });

    test('can be skipped, and replayed from the header', async ({ page }) => {
        await showTour(page);
        await startNewGame(page);

        await page.click('#tour-skip-btn');
        await expect(page.locator('#tour-card')).toBeHidden();

        await page.click('#tour-btn');
        await expect(page.locator('#tour-title')).toHaveText('Welcome aboard, Captain');
    });
});

test.describe('tutorial messages hold the clock', () => {
    const clock = page => page.evaluate(() => window.game.gameTime);

    test('time stands still during the tour and starts once it is dismissed', async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('starshipOps.tourSeen'));
        await startNewGame(page);

        await page.waitForTimeout(2200); // two real ticks' worth
        expect(await clock(page)).toBe(0);

        // The controls still work while time is held.
        await page.click('#tour-next-btn');
        await page.click('#tour-next-btn');
        await page.click('#vent-toggle');
        expect(await page.evaluate(() => window.game.ventsOpen)).toBe(true);

        await page.click('#tour-skip-btn');
        await expect.poll(() => clock(page), { timeout: 4000 }).toBeGreaterThan(0);
    });

    test('time stands still while a tip is showing', async ({ page }) => {
        await page.addInitScript(() => localStorage.removeItem('starshipOps.tipsOff'));
        await startNewGame(page);

        await page.evaluate(() => { window.game.systems.transceiver.repairPct = 100; window.game.tour.checkTips(); });
        await expect(page.locator('#tour-card')).toBeVisible();
        const held = await clock(page);
        await page.waitForTimeout(2200);
        expect(await clock(page)).toBe(held);

        await page.click('#tour-next-btn'); // "Got it"
        await expect.poll(() => clock(page), { timeout: 4000 }).toBeGreaterThan(held);
    });
});

test.describe('contextual tips', () => {
    const enableTips = page => page.addInitScript(() => localStorage.removeItem('starshipOps.tipsOff'));

    test('a tip fires once when its condition first becomes true, and not again', async ({ page }) => {
        await enableTips(page);
        await startNewGame(page);

        // Nothing is due on a brand new ship.
        await page.evaluate(() => window.game.tour.checkTips());
        await expect(page.locator('#tour-card')).toBeHidden();

        await page.evaluate(() => { window.game.systems.transceiver.repairPct = 100; window.game.tour.checkTips(); });
        await expect(page.locator('#tour-step-count')).toHaveText('Tip · time paused');
        await expect(page.locator('#tour-title')).toHaveText('Transceiver repaired');

        await page.click('#tour-next-btn'); // "Got it"
        await expect(page.locator('#tour-card')).toBeHidden();

        // Still true, but already shown for this save. Switching it on then makes the next tip due.
        await page.evaluate(() => window.game.tour.checkTips());
        await expect(page.locator('#tour-card')).toBeHidden();

        await page.click('#transceiver-toggle');
        await page.evaluate(() => { window.game.systemUpdate.update(1); window.game.tour.checkTips(); });
        await expect(page.locator('#tour-title')).toHaveText('The local market is in range');
    });

    test('"Turn off tips" stops any further tips', async ({ page }) => {
        await enableTips(page);
        await startNewGame(page);

        await page.evaluate(() => { window.game.systems.transceiver.repairPct = 100; window.game.tour.checkTips(); });
        await page.click('#tour-skip-btn'); // reads "Turn off tips" on a tip
        await expect(page.locator('#tour-card')).toBeHidden();

        await page.evaluate(() => { window.game.systems.blackWater.exposureHours = 3; window.game.tour.checkTips(); });
        await expect(page.locator('#tour-card')).toBeHidden();
    });
});
