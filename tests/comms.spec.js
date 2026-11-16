// E2E coverage for the Comms & Nav panel: the procedurally-generated sector
// roster (current location + trading post + comms signal), the list/selection
// UI, distance display, and persistence across save/reload.
const { expect } = require('@playwright/test');
const { test, startNewGame, bringCommsOnline } = require('./helpers.js');

test.describe('comms & nav', () => {
    test('opens with Kel Veth III marked current and two other charted entries', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await page.click('#comms-nav-btn');
        await page.waitForSelector('#comms-nav-screen', { state: 'visible' });

        await expect(page.locator('.comms-location-card')).toHaveCount(3);

        const kinds = await page.evaluate(() => window.game.commsLocations.map(l => l.kind).sort());
        expect(kinds).toEqual(['home', 'location', 'signal']);

        const homeCard = page.locator('.comms-location-card').filter({ hasText: 'Kel Veth III' });
        await expect(homeCard.locator('.comms-location-kind')).toHaveText('Current Location');
    });

    test('selecting the trading post or signal shows a positive distance; Kel Veth shows "You are here"', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await page.click('#comms-nav-btn');
        await page.waitForSelector('#comms-nav-screen', { state: 'visible' });

        const locations = await page.evaluate(() => window.game.commsLocations);
        const nonHome = locations.find(l => l.kind !== 'home');

        await page.click(`.comms-location-card[data-comms-id="${nonHome.id}"]`);
        const detailsText = await page.textContent('#comms-details-pane');
        expect(detailsText).toContain(nonHome.name);
        expect(detailsText).toMatch(/Distance: \d+\.\d{2} ly/);

        const home = locations.find(l => l.kind === 'home');
        await page.click(`.comms-location-card[data-comms-id="${home.id}"]`);
        const homeDetailsText = await page.textContent('#comms-details-pane');
        expect(homeDetailsText).toContain('You are here');
    });

    test('clicking a marker in the plane view selects the same location as the list', async ({ page }) => {
        await startNewGame(page);
        await bringCommsOnline(page);
        await page.click('#comms-nav-btn');
        await page.waitForSelector('#comms-nav-screen', { state: 'visible' });

        const locations = await page.evaluate(() => window.game.commsLocations);
        const signal = locations.find(l => l.kind === 'signal');

        await page.locator(`.comms-marker[data-comms-id="${signal.id}"]`).first().click();
        await expect(page.locator(`.comms-location-card[data-comms-id="${signal.id}"]`)).toHaveClass(/comms-location-selected/);
    });

    test('comms locations and seed persist across save and reload', async ({ page }) => {
        const name = await startNewGame(page);
        const before = await page.evaluate(() => ({ seed: window.game.commsSeed, locations: window.game.commsLocations }));

        await page.evaluate(() => window.game.saveGame());
        page.once('dialog', d => d.accept());
        await page.keyboard.press('Escape');
        await page.click('#main-menu-btn');
        await page.waitForSelector('#launch-screen', { state: 'visible' });

        await page.click('#load-game-btn');
        await page.waitForSelector('#save-list .save-card', { timeout: 5000 });
        await page.locator('.save-card').filter({ hasText: name }).locator('.save-load-btn').click();
        await page.waitForSelector('#game-container', { state: 'visible' });

        const after = await page.evaluate(() => ({ seed: window.game.commsSeed, locations: window.game.commsLocations }));
        expect(after).toEqual(before);
    });
});

test.describe('sector seed screen', () => {
    test('pre-fills a random seed that can be edited before continuing', async ({ page }) => {
        const name = `Seed Test ${Date.now()}`;
        page.once('dialog', d => d.accept(name));
        await page.goto('/');
        await page.click('#new-game-btn');
        await page.waitForSelector('#seed-screen', { state: 'visible' });

        const prefilled = await page.inputValue('#seed-input');
        expect(prefilled).toMatch(/^\d+$/);

        await page.fill('#seed-input', '42');
        await page.click('#seed-continue-btn');
        await page.click('#intro-continue-btn');
        await page.waitForSelector('#game-container', { state: 'visible' });

        const seed = await page.evaluate(() => window.game.commsSeed);
        expect(seed).toBe(42);
    });

    test('regenerate button rerolls the displayed seed without leaving the screen', async ({ page }) => {
        const name = `Seed Test ${Date.now()}`;
        page.once('dialog', d => d.accept(name));
        await page.goto('/');
        await page.click('#new-game-btn');
        await page.waitForSelector('#seed-screen', { state: 'visible' });

        const before = await page.inputValue('#seed-input');
        await page.click('#seed-regenerate-btn');
        const after = await page.inputValue('#seed-input');

        expect(after).toMatch(/^\d+$/);
        expect(after).not.toBe(before);
    });

    test('the same seed reproduces the same sector layout', async ({ page }) => {
        const seed = '777777';

        async function newGameWithSeed() {
            const name = `Seed Repro ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            page.once('dialog', d => d.accept(name));
            await page.click('#new-game-btn');
            await page.waitForSelector('#seed-screen', { state: 'visible' });
            await page.fill('#seed-input', seed);
            await page.click('#seed-continue-btn');
            await page.click('#intro-continue-btn');
            await page.waitForSelector('#game-container', { state: 'visible' });
            return page.evaluate(() => window.game.commsLocations.map(({ kind, name, x, y, z }) => ({ kind, name, x, y, z })));
        }

        await page.goto('/');
        const first = await newGameWithSeed();

        page.once('dialog', d => d.accept()); // confirm() inside returnToMainMenu
        await page.keyboard.press('Escape');
        await page.click('#main-menu-btn');
        await page.waitForSelector('#launch-screen', { state: 'visible' });

        const second = await newGameWithSeed();

        expect(second).toEqual(first);
    });
});
