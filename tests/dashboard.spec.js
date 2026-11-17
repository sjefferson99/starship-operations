// Dashboard layout (main.js _layoutCards): grouped cards that collapse to
// their headline, fixed card heights with a "More" toggle, and messages that
// float beside their element (anchor.js) instead of pushing the layout around.

const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers');

const freeze = page => page.evaluate(() => window.game._stopTimer());
const box = (page, sel) => page.locator(sel).evaluate(e => {
    const r = e.getBoundingClientRect(); // page coordinates, so scrolling doesn't count as moving
    return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height, bottom: r.bottom + scrollY };
});

test.describe('dashboard groups', () => {
    test('a group collapses to each card\'s status and coloured bar; collapse all / expand all', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        await expect(page.locator('#o2-consumption')).toBeVisible();
        await page.click('#group-life-support .card-group-header');
        await expect(page.locator('#group-life-support')).toHaveClass(/collapsed/);
        await expect(page.locator('#o2-status-badge')).toBeVisible();
        await expect(page.locator('#card-o2 .gauge-track')).toBeVisible();
        await expect(page.locator('#o2-consumption')).toBeHidden();
        await expect(page.locator('#o2-toggle')).toBeHidden();
        await expect(page.locator('#power-toggle')).toBeHidden(); // power shares the group
        await expect(page.locator('#water-ration-toggle')).toBeVisible(); // other groups untouched

        await page.click('#collapse-all-btn');
        await expect(page.locator('.card-group.collapsed')).toHaveCount(3);
        await expect(page.locator('#card-blackwater .gauge-track')).toBeVisible();
        await expect(page.locator('#blackwater-dump-btn')).toBeHidden();
        // Remembered as a viewing preference.
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('starshipOps.dashboardLayout')).collapsedGroups.length)).toBe(3);

        await page.click('#expand-all-btn');
        await expect(page.locator('.card-group.collapsed')).toHaveCount(0);
        await expect(page.locator('#o2-toggle')).toBeVisible();
    });

    test('each group header sums up its cards\' status', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        await page.evaluate(() => { window.game.systems.o2.pct = 10; window.game.systemUpdate._updateStatuses(); window.game.updateDisplay(); });
        const critical = await page.locator('#group-life-support .system-card.card-critical').count();
        expect(critical).toBeGreaterThan(0);
        await expect(page.locator('#group-life-support-status')).toHaveText(`${critical} critical`);
        await expect(page.locator('#card-o2')).toHaveClass(/card-critical/);
    });
});

test.describe('fixed-height cards', () => {
    test('every card is the same height, and a message appearing doesn\'t move the layout', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const heights = await page.locator('.system-card').evaluateAll(cards => cards.map(c => c.offsetHeight));
        expect(new Set(heights).size).toBe(1);

        const before = await box(page, '#card-blackwater');
        // Rationing shows a whole extra block on the Fresh Water card.
        await page.click('#water-ration-toggle');
        await page.evaluate(() => window.game.updateDisplay());
        expect(await box(page, '#card-blackwater')).toEqual(before);
        expect((await box(page, '#card-freshwater')).h).toBe(heights[0]);
    });

    test('a card with more to say than fits offers More, which grows just that card', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);

        const more = page.locator('#card-freshwater .card-more-btn');
        await expect(more).toBeHidden();
        // Squeeze the details so they can't all fit.
        await page.evaluate(() => { document.querySelector('.system-dashboard').style.setProperty('--card-h', '300px'); window.game.updateDisplay(); });
        await expect(more).toBeVisible();
        await expect(more).toHaveText('More ▾');
        await expect(page.locator('#card-freshwater .card-details')).toHaveClass(/card-details-clipped/);

        const otherBefore = (await box(page, '#card-food')).h;
        await more.click();
        await expect(more).toHaveText('Less ▴');
        const freshH = (await box(page, '#card-freshwater')).h;
        expect(freshH).toBeGreaterThan(300);
        expect((await box(page, '#card-food')).h).toBe(otherBefore);
        await more.click();
        expect((await box(page, '#card-freshwater')).h).toBe(300);
    });
});

test.describe('anchored messages', () => {
    test('the idle-crew note floats under the Crew counter without growing the header', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const header = (await box(page, '.game-header')).h;

        await page.evaluate(() => {
            const g = window.game;
            g.gameTime = 12 * 3600;
            g.crewManifest[0].shifts = [{ startHour: 8, endHour: 20 }];
            g.repairQueue = [];
            g.updateDisplay();
        });
        const note = page.locator('#crew-idle-note');
        await expect(note).toBeVisible();
        await expect(note).toHaveClass(/anchored/);
        expect((await box(page, '.game-header')).h).toBe(header);

        // Below the Crew counter, its pointer at the counter's centre.
        await expect.poll(async () => {
            const crew = await box(page, '#crew-stat');
            const n = await box(page, '#crew-idle-note');
            const arrow = await note.evaluate(e => parseFloat(e.style.getPropertyValue('--arrow-x')));
            return n.y > crew.bottom && Math.abs(n.x + arrow - (crew.x + crew.w / 2)) < 2;
        }).toBe(true);
    });

    test('an action\'s result appears beside the button that caused it', async ({ page }) => {
        await startNewGame(page);
        await freeze(page);
        const header = (await box(page, '.game-header')).h;

        await page.evaluate(() => { window.game.systems.blackWater.liquidL = 50; window.game.syncBlackWaterLevel(); window.game.updateDisplay(); });
        await page.click('#blackwater-dump-btn');
        const status = page.locator('#save-status');
        await expect(status).toHaveText('Fined 100 credits for dumping waste');
        expect((await box(page, '.game-header')).h).toBe(header);

        await expect.poll(async () => {
            const btn = await box(page, '#blackwater-dump-btn');
            const s = await box(page, '#save-status');
            return Math.abs(s.y - (btn.bottom + 10)) < 2 || Math.abs(s.bottom - (btn.y - 10)) < 2;
        }).toBe(true);
    });
});
