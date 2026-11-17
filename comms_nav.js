// Comms & Nav domain logic: procedurally generates the small set of known/
// detected points of interest in the current sector (current location, a
// trading post, a comms signal source) from a seeded RNG, decides which of
// them the ship's transceiver can currently reach, and owns the local market
// (items for sale). Kept separate from main.js for the same reason
// RepairManager/CrewManager are — a self-contained domain the dashboard UI
// reads from rather than owns.

// mulberry32 (rng.js) drives sector generation, so the same seed always
// produces the same sector.

class CommsNav {
    constructor(game) {
        this.game = game;

        this.GRID_SIZE   = 10;  // the home location is placed anywhere within this 10x10x10 cube
        this.NEARBY_RANGE = 1;  // other locations are offset from home by up to this much per axis

        this.TRADING_POST_NAMES = ['Harlow Station', 'Carrow Trading Post', 'Venn Outpost', 'Relay 7 Exchange'];
        this.SIGNAL_NAMES       = ['Unidentified Transmission', 'Signal Source Theta', 'Encrypted Burst', 'Stray Carrier Wave'];

        // Transceiver range needed before anything is revealed. The local
        // network (the current location's market and news) always comes first;
        // anything further away needs at least MIN_REMOTE_RANGE_LY, and of
        // course enough range to actually cover the distance. A tier-1
        // transceiver's rated range (see module_specs.json) only just covers
        // the three starting contacts.
        this.LOCAL_DETAILS_RANGE_LY = 0.25;
        this.MIN_REMOTE_RANGE_LY    = 0.3;

        // Market stock: every unit on sale is salvage in some state of
        // disrepair, priced on a straight line between these by condition.
        this.MARKET_MIN_PRICE  = 100;
        this.MARKET_MAX_PRICE  = 200;
        this.MARKET_MIN_REPAIR = 8;   // % — below 20% a repair is a gamble (RepairManager's replacement band)
        this.MARKET_MAX_REPAIR = 45;
        this.MARKET_STOCK = [
            { moduleKey: 'waterMaker',  name: 'Water Maker',     count: 3 },
            { moduleKey: 'transceiver', name: 'Transceiver',     count: 1 },
            { moduleKey: 'power',       name: 'Power Generator', count: 1 },
            { moduleKey: 'o2',          name: 'O₂ Generator',    count: 1 },
            { moduleKey: 'co2',         name: 'CO₂ Scrubber',    count: 1 },
        ];
    }

    // Random 32-bit seed, used both for the initial roll shown on the seed
    // screen and by "Regenerate" there.
    rollSeed() {
        return Math.floor(Math.random() * 2 ** 31);
    }

    // Builds the 3-location roster and the local market from `seed` (rolls a
    // fresh one if omitted). The result is what gets persisted, not the seed
    // alone — the seed is kept only for display/re-entry, generation never
    // needs to be re-run from it after this point.
    generate(seed) {
        const finalSeed = seed != null ? seed : this.rollSeed();
        const rng = mulberry32(finalSeed);

        const home = {
            id: 'home', kind: 'home', name: 'Kel Veth III',
            x: rng() * this.GRID_SIZE, y: rng() * this.GRID_SIZE, z: rng() * this.GRID_SIZE,
        };

        const tradingPost = this._nearbyLocation(rng, 'location', this._pick(rng, this.TRADING_POST_NAMES), home, finalSeed);
        const signal       = this._nearbyLocation(rng, 'signal',  this._pick(rng, this.SIGNAL_NAMES), home, finalSeed);

        this.game.commsSeed      = finalSeed;
        this.game.commsLocations = [home, tradingPost, signal];
        // Market rolls come after every location roll so adding the market
        // didn't change which sector layout a given seed produces.
        this.game.market         = this._generateMarket(rng, home);
        return finalSeed;
    }

    _pick(rng, list) {
        return list[Math.floor(rng() * list.length)];
    }

    // The id comes from the seed, not a roll. Drawing from `rng` for it would
    // shift every roll after it and move the sector a seed produces.
    _nearbyLocation(rng, kind, name, home, seed) {
        const offset = () => (rng() * 2 - 1) * this.NEARBY_RANGE; // [-range, range]
        const clamp  = v => Math.max(0, Math.min(this.GRID_SIZE, v));
        return {
            id: kind + '-' + (seed >>> 0).toString(36),
            kind, name,
            x: clamp(home.x + offset()),
            y: clamp(home.y + offset()),
            z: clamp(home.z + offset()),
        };
    }

    // What sort of place a location is ("Planet", "Station", ...). Derived from
    // `kind` rather than stored: the comms_locations table has no type column,
    // and today each kind only ever generates one type. Once travel introduces
    // varied destinations this wants to become a persisted per-location field
    // (an explicit `loc.type` already wins here if present).
    locationTypeLabel(loc) {
        if (!loc) return '';
        if (loc.type) return loc.type;
        switch (loc.kind) {
            case 'home':     return 'Planet';
            case 'location': return 'Station';
            case 'signal':   return 'Signal Source';
            default:         return 'Unknown';
        }
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

    // ── Transceiver reach ───────────────────────────────────────────────────
    // Nothing here is remembered: what's visible is purely what the
    // transceiver can reach right now, so switching it off (or running out of
    // power) drops every contact until it's back.

    rangeLy() {
        return this.game.systems.transceiver?.rangeLy || 0;
    }

    // The current location's market and news.
    hasLocalDetails() {
        return this.rangeLy() >= this.LOCAL_DETAILS_RANGE_LY;
    }

    // Range needed before `loc` shows up at all. You always know where you are.
    revealRangeLy(loc) {
        if (!loc || loc.kind === 'home') return 0;
        return Math.max(this.MIN_REMOTE_RANGE_LY, this.distanceFromHome(loc));
    }

    isRevealed(loc) {
        return this.rangeLy() >= this.revealRangeLy(loc);
    }

    visibleLocations() {
        return (this.game.commsLocations || []).filter(loc => this.isRevealed(loc));
    }

    // ── Market ──────────────────────────────────────────────────────────────

    _generateMarket(rng, home) {
        const listings = [];
        const span = this.MARKET_MAX_REPAIR - this.MARKET_MIN_REPAIR;
        this.MARKET_STOCK.forEach(stock => {
            for (let i = 0; i < stock.count; i++) {
                const repairPct = Math.round(this.MARKET_MIN_REPAIR + rng() * span);
                const condition = (repairPct - this.MARKET_MIN_REPAIR) / span;
                listings.push({
                    id: `mkt-${listings.length + 1}`,
                    locationId: home.id,
                    moduleKey: stock.moduleKey,
                    name: `Salvaged ${stock.name}`,
                    repairPct,
                    price: Math.round(this.MARKET_MIN_PRICE + condition * (this.MARKET_MAX_PRICE - this.MARKET_MIN_PRICE)),
                });
            }
        });
        return listings;
    }

    listingsAt(loc) {
        if (!loc) return [];
        return (this.game.market || []).filter(l => l.locationId === loc.id);
    }

    // Purchases are in person only for now: the ship has to be at the
    // location, it has to be a planet, and the local network has to be in
    // range. (Delivery, drones and station trade come later.)
    canTradeAt(loc) {
        const home = this.home();
        return !!loc && !!home && loc.id === home.id &&
               this.locationTypeLabel(home) === 'Planet' && this.hasLocalDetails();
    }

    // Returns null if `listing` can be bought right now, otherwise the reason not.
    // `dest` is 'fit' (straight into the ship's slot for it) or 'store' (into
    // an empty machine storage box, as a spare or something to repair and sell).
    purchaseBlocker(listing, dest = 'fit') {
        const sys = this.game.systems[listing.moduleKey];
        if (!sys) return 'Not compatible with this ship';
        const loc = (this.game.commsLocations || []).find(l => l.id === listing.locationId);
        if (!this.canTradeAt(loc)) return 'You have to be on the planet to buy';
        if (dest === 'store') {
            const fab = this.game.fabrication;
            if (!fab.emptyMachineBox()) return 'Needs an empty machine storage box';
            if (this.game.credits < listing.price) return 'Not enough credits';
            return fab.spaceBlocker(fab.moduleMassKg({ moduleKey: listing.moduleKey, tier: 1 }), 0);
        }
        if (sys.installed !== false && !sys.destroyed) return 'Already fitted — only needed if yours is destroyed, or to store in a machine box';
        if (this.game.credits < listing.price) return 'Not enough credits';
        return null;
    }

    // Fits the bought unit straight into the ship in whatever state it was
    // sold in, replacing a destroyed one if there was one — or, with
    // dest 'store', puts it in an empty machine box. Returns true on success.
    purchase(listingId, dest = 'fit') {
        const listing = (this.game.market || []).find(l => l.id === listingId);
        if (!listing || this.purchaseBlocker(listing, dest)) return false;

        if (dest === 'store') {
            this.game.fabrication.storeModule({ moduleKey: listing.moduleKey, tier: 1, repairPct: listing.repairPct });
        } else {
            const sys = this.game.systems[listing.moduleKey];
            sys.installed  = true;
            sys.destroyed  = false;
            sys.juryRigged = false;
            sys.active     = false;
            sys.repairPct  = listing.repairPct;
            this.game.repairQueue = this.game.repairQueue.filter(t => t.systemKey !== listing.moduleKey);
        }

        this.game.credits -= listing.price;
        this.game.market = this.game.market.filter(l => l.id !== listingId);
        return true;
    }
}
