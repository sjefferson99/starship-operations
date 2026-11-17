// Seeded randomness. Loaded first: CommsNav and StarshipGame both use it.
//
// mulberry32 is a small, fast, deterministic PRNG. The same seed always gives
// the same sequence. Its whole state is one 32-bit integer, so `GameRng`
// can save that integer in the game snapshot and pick the sequence back up
// exactly where it stopped. That's what lets a save (or a future rewind
// checkpoint) replay the same rolls. See docs/rewind-readiness.md.

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Every gameplay roll (crew variance, infections, repair destroy chances…)
// goes through `game.rng.next()`, never Math.random(). It's a separate stream
// from the sector generator, so adding a new gameplay roll never moves where a
// seed puts the sector's planets.
class GameRng {
    // Mixed into the sector seed so gameplay rolls don't follow the same
    // sequence as sector generation.
    static STREAM_SALT = 0x9E3779B9;

    constructor(state = 0) {
        this.state = state >>> 0;
    }

    // Start a new game's stream from its sector seed.
    static fromSeed(seed) {
        return new GameRng((seed ^ GameRng.STREAM_SALT) >>> 0);
    }

    // Same algorithm as mulberry32, but the state lives on the object so it
    // can be saved and restored.
    next() {
        let a = (this.state + 0x6D2B79F5) | 0;
        this.state = a >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}
