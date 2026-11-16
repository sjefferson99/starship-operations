const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

test.describe('manual ship capacity modal verification', () => {
    test('capacity modal opens from dashboard button and closes cleanly', async ({ page }) => {
        const consoleErrors = [];
        page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        page.on('pageerror', err => consoleErrors.push(err.message));

        await startNewGame(page);
        await page.waitForTimeout(500);

        // Should not be visible on the dashboard anymore.
        const inlineCard = await page.$('#card-capacity');
        expect(inlineCard).toBeNull();

        await page.screenshot({ path: 'test-results/capacity-dashboard.png', fullPage: true });

        // Open via the new header button.
        await page.click('#ship-capacity-btn');
        await page.waitForSelector('#ship-capacity-screen', { state: 'visible' });
        await page.screenshot({ path: 'test-results/capacity-modal-open.png', fullPage: true });

        const breakdownHtml = await page.innerHTML('#capacity-breakdown');
        console.log('BREAKDOWN HTML:', breakdownHtml);
        expect(breakdownHtml).toContain('Hull (unladen)');
        expect(breakdownHtml).toContain('Fresh Water Tank');

        const massText = await page.textContent('#capacity-mass-level');
        console.log('Mass text in modal:', massText);
        expect(massText).toContain('kg');

        // Close it.
        await page.click('#ship-capacity-close-btn');
        const isHidden = await page.evaluate(() => document.getElementById('ship-capacity-screen').style.display === 'none');
        expect(isHidden).toBe(true);

        console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors));
        expect(consoleErrors).toEqual([]);
    });
});
