// GameState — serialise / restore the entire game as a plain JSON object.
//
// Persistence backends:
//   saveLocal / loadLocal  — browser localStorage (current implementation)
//   exportFile / importFile — portable .json file download/upload
//
// To switch to a REST backend, replace the localStorage calls with:
//   POST /api/saves     body: JSON.stringify(GameState.snapshot(game))
//   GET  /api/saves/latest → then GameState.restore(game, responseJson)

class GameState {
    static VERSION = '1.0.0';

    // Full snapshot of every value needed to reconstruct the game.
    // System units carry tier + count so upgrades are representable from day 1.
    static snapshot(game) {
        const s = game.systems;
        return {
            version: GameState.VERSION,
            savedAt: new Date().toISOString(),

            world: {
                gameTime:  game.gameTime,   // total game-seconds elapsed
                credits:   game.credits,
                gameSpeed: game.gameSpeed,  // 1 | 10 | 100
            },

            crew: {
                count: game.crew,
            },

            ship: {
                volumeM3: 16,
            },

            systems: {
                // Atmospheric state
                atmosphere: {
                    o2Pct:  s.o2.pct,   // current atmospheric O2 %
                    co2Pct: s.co2.pct,  // current atmospheric CO2 %
                },

                // O2 generator units
                o2Generator: {
                    active: s.o2.active,
                    count:  s.o2.count,
                    tier:   s.o2.tier,
                    target: s.o2.target ?? 21.0,
                },

                // CO2 scrubber units
                co2Scrubber: {
                    active: s.co2.active,
                    count:  s.co2.count,
                    tier:   s.co2.tier,
                    target: s.co2.target ?? 0.04,
                },

                // Battery bank
                battery: {
                    currentWh:  s.power.current,
                    capacityWh: s.power.capacity,
                    count:      s.power.count,
                    tier:       s.power.tier,
                    target:     s.power.target ?? 80.0,
                },

                // Generator (fuel-powered, enables battery charging)
                generator: {
                    active: s.power.active,
                },

                // Fuel tank
                fuel: {
                    currentL:  s.fuel.current,
                    capacityL: s.fuel.capacity,
                },
            },

            environment: {
                inBreathableAtmosphere: game.inBreathableAtmosphere,
                ventsOpen:              game.ventsOpen,
            },
        };
    }

    // Apply a snapshot back onto a live game instance.
    static restore(game, snap) {
        if (!snap || snap.version !== GameState.VERSION) {
            throw new Error(
                `Incompatible save version "${snap?.version ?? 'unknown'}" — expected ${GameState.VERSION}`
            );
        }

        game.gameTime  = snap.world.gameTime;
        game.credits   = snap.world.credits;
        game.gameSpeed = snap.world.gameSpeed;
        game.crew      = snap.crew.count;

        const s = snap.systems;

        game.systems.o2.pct    = s.atmosphere.o2Pct;
        game.systems.co2.pct   = s.atmosphere.co2Pct;

        game.systems.o2.active = s.o2Generator.active;
        game.systems.o2.count  = s.o2Generator.count;
        game.systems.o2.tier   = s.o2Generator.tier;
        game.systems.o2.target = s.o2Generator.target ?? 21.0;

        game.systems.co2.active  = s.co2Scrubber.active;
        game.systems.co2.count   = s.co2Scrubber.count;
        game.systems.co2.tier    = s.co2Scrubber.tier;
        game.systems.co2.target  = s.co2Scrubber.target ?? 0.04;

        game.systems.power.current  = s.battery.currentWh;
        game.systems.power.capacity = s.battery.capacityWh;
        game.systems.power.count    = s.battery.count;
        game.systems.power.tier     = s.battery.tier;
        game.systems.power.active   = s.generator.active;
        game.systems.power.level    = (s.battery.currentWh / s.battery.capacityWh) * 100;
        game.systems.power.target   = s.battery.target ?? 80.0;

        game.systems.fuel.current  = s.fuel.currentL;
        game.systems.fuel.capacity = s.fuel.capacityL;
        game.systems.fuel.level    = (s.fuel.currentL / s.fuel.capacityL) * 100;

        game.inBreathableAtmosphere = snap.environment?.inBreathableAtmosphere ?? false;
        game.ventsOpen              = snap.environment?.ventsOpen              ?? false;
    }

    // ── Server-side save (requires: node server.js) ───────────────────────
    // Writes to savegame/save.json via POST /api/save.

    static async saveServer(game) {
        const snap = GameState.snapshot(game);
        const resp = await fetch('/api/save', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(snap, null, 2),
        });
        if (!resp.ok) throw new Error('Server responded ' + resp.status);
        return snap;
    }

    static async loadServer(game) {
        const resp = await fetch('/api/save');
        if (resp.status === 404) throw new Error('No save file found. Save first, then load.');
        if (!resp.ok) throw new Error('Server responded ' + resp.status);
        GameState.restore(game, await resp.json());
    }

    static async hasSaveServer() {
        try {
            const resp = await fetch('/api/save', { method: 'HEAD' });
            return resp.ok;
        } catch { return false; }
    }

    // ── File I/O (portable across devices) ────────────────────────────────

    static exportFile(game) {
        const snap = GameState.snapshot(game);
        const day  = Math.floor(snap.world.gameTime / 86400) + 1;
        const json = JSON.stringify(snap, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `starship_day${day}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    static importFile(game, onDone) {
        const input   = document.createElement('input');
        input.type    = 'file';
        input.accept  = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    GameState.restore(game, JSON.parse(ev.target.result));
                    onDone(null);
                } catch (err) {
                    onDone(err);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
}
