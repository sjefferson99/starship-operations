// Coverage for named save slots: New Game prompts for a name, Load Game lists
// saves with previews, saves can be loaded back exactly, deleted, and duplicate
// names are blocked rather than silently overwritten.
const { expect } = require('@playwright/test');
const { test, startNewGame, quitToMenu } = require('./helpers.js');

function uniqueName(label) {
    return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function openLoadScreen(page) {
    await page.click('#load-game-btn');
    // The screen becomes visible synchronously, but the list itself populates
    // asynchronously (fetches GET /api/saves) — wait for actual rows, not just
    // the (empty) container.
    await page.waitForSelector('#save-list .save-card', { timeout: 5000 });
}

test.describe('save slots', () => {
    test('two named saves both appear in the Load list with correct previews', async ({ page }) => {
        const nameA = uniqueName('Save A');
        const nameB = uniqueName('Save B');

        await startNewGame(page, nameA);
        await page.evaluate(() => { window.game.credits = 1234; });
        await page.evaluate(() => window.game.saveGame());
        await quitToMenu(page);

        await startNewGame(page, nameB);
        await quitToMenu(page);

        await openLoadScreen(page);
        const titles = await page.locator('.save-title').allTextContents();
        expect(titles).toContain(nameA);
        expect(titles).toContain(nameB);

        const rowA = page.locator('.save-card').filter({ hasText: nameA });
        await expect(rowA.locator('.save-meta')).toContainText('1234 credits');
    });

    test('loading a save restores its exact state', async ({ page }) => {
        const name = uniqueName('Load Test');
        await startNewGame(page, name);
        await page.evaluate(() => {
            window.game.credits = 4242;
            window.game.systems.o2.repairPct = 60;
        });
        await page.evaluate(() => window.game.saveGame());
        await quitToMenu(page);

        await openLoadScreen(page);
        await page.locator('.save-card').filter({ hasText: name }).locator('.save-load-btn').click();
        await page.waitForSelector('#game-container', { state: 'visible' });

        const state = await page.evaluate(() => ({ credits: window.game.credits, o2RepairPct: window.game.systems.o2.repairPct }));
        expect(state.credits).toBe(4242);
        expect(state.o2RepairPct).toBe(60);
    });

    test('deleting a save removes it from the list', async ({ page }) => {
        const name = uniqueName('Delete Test');
        await startNewGame(page, name);
        await quitToMenu(page);

        await openLoadScreen(page);
        page.once('dialog', d => d.accept()); // confirm() inside _deleteSave
        await page.locator('.save-card').filter({ hasText: name }).locator('.save-delete-btn').click();
        await expect(page.locator('.save-card').filter({ hasText: name })).toHaveCount(0);
    });

    test('a duplicate save name is blocked and re-prompts for a different one', async ({ page }) => {
        const dupName = uniqueName('Dup');
        await startNewGame(page, dupName);
        await quitToMenu(page);

        const retryName = `${dupName} v2`;
        const dialogMessages = [];
        page.on('dialog', d => {
            dialogMessages.push(d.message());
            d.accept(dialogMessages.length === 1 ? dupName : retryName);
        });
        await page.click('#new-game-btn');
        await page.waitForSelector('#seed-screen', { state: 'visible' });

        expect(dialogMessages.some(m => m.includes('already exists'))).toBe(true);

        await page.click('#seed-continue-btn');
        await page.waitForSelector('#intro-modal', { state: 'visible' });
        await page.click('#intro-continue-btn');
        await page.waitForSelector('#game-container', { state: 'visible' });

        const savedName = await page.evaluate(() => window.game.saveName);
        expect(savedName).toBe(retryName);
    });

    test('save names are escaped in the load list (no script injection)', async ({ page }) => {
        const xssName = '<img src=x onerror="window.__xss=true">';
        await startNewGame(page, xssName);
        await quitToMenu(page);
        await openLoadScreen(page);

        const xssTriggered = await page.evaluate(() => window.__xss === true);
        expect(xssTriggered).toBe(false);
        // Other tests in this run have created their own saves too — scope to this one.
        await expect(page.locator('.save-card').filter({ hasText: xssName }).locator('.save-title')).toContainText(xssName);
    });
});
