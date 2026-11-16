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
        await expect(page.locator('#location-name')).toHaveText('Kel Veth III');
        await expect(page.locator('#location-type')).toHaveText('Planet · Breathable atmosphere');
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

        // Action steps have no Next button — they advance on the real control.
        await expect(title).toHaveText('Open the vents');
        await expect(page.locator('#tour-next-btn')).toBeHidden();
        await page.click('#vent-toggle');

        await expect(title).toHaveText('Ration the water');
        await page.click('#water-ration-toggle');

        await expect(title).toHaveText('No power, no systems');
        await page.click('#tour-next-btn');

        await expect(title).toHaveText('Repair the transceiver first');
        await page.click('#transceiver-repair-btn');

        await expect(title).toHaveText('The Repair Queue');
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

test.describe('contextual tips', () => {
    const enableTips = page => page.addInitScript(() => localStorage.removeItem('starshipOps.tipsOff'));

    test('a tip fires once when its condition first becomes true, and not again', async ({ page }) => {
        await enableTips(page);
        await startNewGame(page);

        // Nothing is due on a brand new ship.
        await page.evaluate(() => window.game.tour.checkTips());
        await expect(page.locator('#tour-card')).toBeHidden();

        await page.evaluate(() => { window.game.systems.transceiver.repairPct = 100; window.game.tour.checkTips(); });
        await expect(page.locator('#tour-step-count')).toHaveText('Tip');
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
