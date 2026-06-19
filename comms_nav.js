// Comms & Nav domain logic: procedurally generates the small set of known/
// detected points of interest in the current sector (current location, a
// trading post, a comms signal source) from a seeded RNG, and computes
// distance from the ship's current location. Kept separate from main.js for
// the same reason RepairManager/CrewManager are — a self-contained domain
// the dashboard UI reads from rather than owns.

// mulberry32 — tiny, fast, deterministic PRNG. Same seed always produces the
// same sequence, which is what makes "Sector Seed: 123456789" meaningful.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class CommsNav {
    constructor(game) {
        this.game = game;

        this.GRID_SIZE   = 10;  // the home location is placed anywhere within this 10x10x10 cube
        this.NEARBY_RANGE = 1;  // other locations are offset from home by up to this much per axis

        this.TRADING_POST_NAMES = ['Harlow Station', 'Carrow Trading Post', 'Venn Outpost', 'Relay 7 Exchange'];
        this.SIGNAL_NAMES       = ['Unidentified Transmission', 'Signal Source Theta', 'Encrypted Burst', 'Stray Carrier Wave'];
    }

    // Random 32-bit seed, used both for the initial roll shown on the seed
    // screen and by "Regenerate" there.
    rollSeed() {
        return Math.floor(Math.random() * 2 ** 31);
    }

    // Builds the 3-location roster from `seed` (rolls a fresh one if omitted).
    // The result is what gets persisted, not the seed alone — the seed is
    // kept only for display/re-entry, generation never needs to be re-run
    // from it after this point.
    generate(seed) {
        const finalSeed = seed != null ? seed : this.rollSeed();
        const rng = mulberry32(finalSeed);

        const home = {
            id: 'home', kind: 'home', name: 'Kel Veth III',
            x: rng() * this.GRID_SIZE, y: rng() * this.GRID_SIZE, z: rng() * this.GRID_SIZE,
        };

        const tradingPost = this._nearbyLocation(rng, 'location', this._pick(rng, this.TRADING_POST_NAMES), home);
        const signal       = this._nearbyLocation(rng, 'signal',  this._pick(rng, this.SIGNAL_NAMES), home);

        this.game.commsSeed      = finalSeed;
        this.game.commsLocations = [home, tradingPost, signal];
        return finalSeed;
    }

    _pick(rng, list) {
        return list[Math.floor(rng() * list.length)];
    }

    _nearbyLocation(rng, kind, name, home) {
        const offset = () => (rng() * 2 - 1) * this.NEARBY_RANGE; // [-range, range]
        const clamp  = v => Math.max(0, Math.min(this.GRID_SIZE, v));
        return {
            id: kind + '-' + Math.random().toString(36).slice(2, 8),
            kind, name,
            x: clamp(home.x + offset()),
            y: clamp(home.y + offset()),
            z: clamp(home.z + offset()),
        };
    }

    home() {
        return (this.game.commsLocations || []).find(l => l.kind === 'home') ?? null;
    }

    distanceFromHome(loc) {
        const home = this.home();
        if (!home || !loc) return 0;
        const dx = loc.x - home.x, dy = loc.y - home.y, dz = loc.z - home.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
}
