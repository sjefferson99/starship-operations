// The seeded gameplay RNG (rng.js). One sector seed should decide every roll
// in a game, and a save should carry on the sequence where it stopped. That's
// what will let a rewind checkpoint replay the same outcomes
// (docs/rewind-readiness.md).
const { expect } = require('@playwright/test');
const { test, startNewGame } = require('./helpers.js');

async function newGameWithSeed(page, seed) {
    const name = `RNG ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    page.once('dialog', d => d.accept(name));
    await page.goto('/');
    await page.click('#new-game-btn');
    await page.waitForSelector('#seed-screen', { state: 'visible' });
    await page.fill('#seed-input', String(seed));
    await page.click('#seed-continue-btn');
    await page.click('#intro-continue-btn');
    await page.waitForSelector('#game-container', { state: 'visible' });
    await page.evaluate(() => window.game._stopTimer());
}

// Crew variance plus the next few gameplay rolls. The state is copied first
// so reading the rolls doesn't move the real game's RNG.
function fingerprint(page) {
    return page.evaluate(() => {
        const g = window.game;
        const probe = new GameRng(g.rng.state);
        return {
            variance: g.crewManifest.map(m => m.varianceFactor),
            rolls: Array.from({ length: 5 }, () => probe.next()),
        };
    });
}

test.describe('seeded gameplay RNG', () => {
    test('the same sector seed gives the same crew and the same rolls', async ({ page }) => {
        await newGameWithSeed(page, 424242);
        const first = await fingerprint(page);
        await newGameWithSeed(page, 424242);
        const second = await fingerprint(page);
        await newGameWithSeed(page, 424243);
        const other = await fingerprint(page);

        expect(second).toEqual(first);
        expect(other).not.toEqual(first);
    });

    test('a save carries on the roll sequence exactly where it stopped', async ({ page }) => {
        await newGameWithSeed(page, 99);
        const { saveId, expected } = await page.evaluate(async () => {
            const g = window.game;
            for (let i = 0; i < 7; i++) g.rng.next(); // move partway into the sequence
            await GameState.saveServer(g);
            const probe = new GameRng(g.rng.state);
            return { saveId: g.saveId, expected: [probe.next(), probe.next(), probe.next()] };
        });

        const resumed = await page.evaluate(async id => {
            const g = window.game;
            g.rng = new GameRng(12345); // throw the live state away
            await GameState.loadServer(g, id);
            return [g.rng.next(), g.rng.next(), g.rng.next()];
        }, saveId);

        expect(resumed).toEqual(expected);
    });

    test('a save from before the seeded RNG still loads, seeded from its sector', async ({ page }) => {
        await startNewGame(page);
        const result = await page.evaluate(() => {
            const g = window.game;
            g._stopTimer();
            const world = GameState.snapshot(g);
            delete world.rng; // what an older save looks like
            GameState.restore(g, world, GameState.shipInstanceSnapshot(g));
            return { state: g.rng.state, expected: GameRng.fromSeed(g.commsSeed).state };
        });
        expect(result.state).toBe(result.expected);
    });

    test('gameplay never falls back to Math.random', async ({ page }) => {
        await startNewGame(page);
        const error = await page.evaluate(() => {
            const g = window.game;
            g._stopTimer();
            const original = Math.random;
            Math.random = () => { throw new Error('Math.random used by gameplay'); };
            try {
                // Exercise every roll: a full sewage tank (infections), a risky
                // salvage stage (destroy chance), and a fresh roster (variance).
                g.systems.blackWater.liquidL = g.systems.blackWater.capacity;
                g.systems.blackWater.exposureHours = 8;
                g.gameTime = 9.5 * 3600;
                g.systems.co2.repairPct = 5;
                g.startRepair('co2');
                g.repairQueue[0].hoursRemaining = 0.0001;
                for (let i = 0; i < 5; i++) g.systemUpdate.update(600);
                g.crewManager.resetRoster();
                return null;
            } catch (e) {
                return e.message;
            } finally {
                Math.random = original;
            }
        });
        expect(error).toBeNull();
    });
});
