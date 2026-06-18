// Regression coverage for the CO2 vent equilibrium bug: opening vents at high
// game speed could overshoot the 400ppm ambient target in a single large tick
// and get stuck near 0% instead of settling back at ambient.
const { test, expect } = require('@playwright/test');
const { startNewGame } = require('./helpers.js');

test.describe('atmosphere venting', () => {
    test('CO2 settles at the 400ppm ambient target, not 0, even at a large tick size', async ({ page }) => {
        await startNewGame(page);

        await page.evaluate(() => {
            window.game.systems.co2.pct = 0.5; // 5000 ppm — well above ambient
            window.game.ventsOpen = true;
        });

        // Drive several large ticks (equivalent to 1000x speed) through the same
        // pipeline the real game loop uses.
        await page.evaluate(() => {
            for (let i = 0; i < 30; i++) window.game.systemUpdate.update(1000);
        });

        const ppm = await page.evaluate(() => window.game.systems.co2.pct * 10000);
        expect(ppm).toBeCloseTo(400, 0);
    });

    test('CO2 never drops below the ambient target while venting down from high levels', async ({ page }) => {
        await startNewGame(page);

        await page.evaluate(() => {
            window.game.systems.co2.pct = 0.5;
            window.game.ventsOpen = true;
        });

        const minPpmSeen = await page.evaluate(() => {
            let min = Infinity;
            for (let i = 0; i < 30; i++) {
                window.game.systemUpdate.update(1000);
                min = Math.min(min, window.game.systems.co2.pct * 10000);
            }
            return min;
        });

        expect(minPpmSeen).toBeGreaterThanOrEqual(400);
    });
});
