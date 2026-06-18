// Shared Playwright helpers. New Game now prompts for a save name via a native
// prompt() dialog, so starting a game requires handling that dialog — every
// spec needs this, so it lives here once rather than copied per file.

// Each call uses a fresh, effectively-unique name (tests share one server/DB for
// the whole run) so creating a save never collides with another test's save.
async function startNewGame(page, saveName) {
    const name = saveName ?? `Test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    page.once('dialog', d => d.accept(name));
    await page.goto('/');
    await page.click('#new-game-btn');
    await page.click('#intro-continue-btn');
    await page.waitForSelector('#game-container', { state: 'visible' });
    return name;
}

module.exports = { startNewGame };
