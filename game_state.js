// GameState — serialise / restore the entire game as a plain JSON object.
//
// Save format v2.0.0:
//   save.json         — world state (time, credits, environment) + shipInstanceId ref
//   ship_instances.json — ship physical state (systems, atmosphere), updated on save
//
// Persistence backends:
//   saveServer / loadServer — REST API via node server.js
//   exportFile / importFile — portable .json file download/upload (world state only)

class GameState {
    static VERSION = '2.0.0';

    // World-state snapshot (no ship systems — those live in ship_instances.json).
    static snapshot(game) {
        return {
            version: GameState.VERSION,
            savedAt: new Date().toISOString(),

            world: {
                gameTime:  game.gameTime,
                credits:   game.credits,
                gameSpeed: game.gameSpeed,
            },

            crew: {
                count: game.crew,
            },

            shipInstanceId: game.shipInstanceId ?? 'player-ship-1',

            environment: {
                inBreathableAtmosphere: game.inBreathableAtmosphere,
                ventsOpen:              game.ventsOpen,
            },
        };
    }

    // Ship instance state snapshot — written to ship_instances.json on save.
    static shipInstanceSnapshot(game, existingInstances) {
        const s = game.systems;
        const instances = existingInstances ? JSON.parse(JSON.stringify(existingInstances)) : { version: '1.0.0', ships: [] };

        const idx = instances.ships.findIndex(sh => sh.id === (game.shipInstanceId ?? 'player-ship-1'));
        const systemState = {
            atmosphere: {
                o2Pct:  s.o2.pct,
                co2Pct: s.co2.pct,
            },
            o2Generator: {
                active: s.o2.active,
                count:  s.o2.count,
                tier:   s.o2.tier,
                target: s.o2.target ?? 21.0,
                repairPct:  s.o2.repairPct ?? 100,
                juryRigged: s.o2.juryRigged ?? false,
                destroyed:  s.o2.destroyed ?? false,
            },
            co2Scrubber: {
                active: s.co2.active,
                count:  s.co2.count,
                tier:   s.co2.tier,
                target: s.co2.target ?? 0.04,
                repairPct:  s.co2.repairPct ?? 100,
                juryRigged: s.co2.juryRigged ?? false,
                destroyed:  s.co2.destroyed ?? false,
            },
            battery: {
                currentWh:  s.power.current,
                capacityWh: s.power.capacity,
                count:      s.power.count,
                tier:       s.power.tier,
                target:     s.power.target ?? 80.0,
            },
            generator: {
                active: s.power.active,
                repairPct:  s.power.repairPct ?? 100,
                juryRigged: s.power.juryRigged ?? false,
                destroyed:  s.power.destroyed ?? false,
            },
            fuel: {
                currentL:  s.fuel.current,
                capacityL: s.fuel.capacity,
            },
        };

        if (idx >= 0) {
            instances.ships[idx].systemState = systemState;
            instances.ships[idx].repairQueue = game.repairQueue ?? [];
        }
        return instances;
    }

    // Apply a world snapshot + ship instance data back onto a live game instance.
    static restore(game, snap, shipInstances) {
        // Support v1.0.0 legacy saves (inline systems, no ship_instances.json)
        if (snap?.version === '1.0.0') {
            GameState._restoreLegacy(game, snap);
            return;
        }

        if (!snap || snap.version !== GameState.VERSION) {
            throw new Error(
                `Incompatible save version "${snap?.version ?? 'unknown'}" — expected ${GameState.VERSION}`
            );
        }

        game.gameTime  = snap.world.gameTime;
        game.credits   = snap.world.credits;
        game.gameSpeed = snap.world.gameSpeed;
        game.crew      = snap.crew.count;
        game.shipInstanceId = snap.shipInstanceId ?? 'player-ship-1';

        game.inBreathableAtmosphere = snap.environment?.inBreathableAtmosphere ?? false;
        game.ventsOpen              = snap.environment?.ventsOpen              ?? false;

        if (shipInstances) {
            const inst = shipInstances.ships?.find(sh => sh.id === game.shipInstanceId);
            if (inst?.systemState) {
                GameState._applySystemState(game, inst.systemState);
                game.shipName         = inst.name;
                game.shipRegistration = inst.registration;
            }
            game.repairQueue = inst?.repairQueue ?? [];
        }
    }

    static _applySystemState(game, s) {
        game.systems.o2.pct    = s.atmosphere.o2Pct;
        game.systems.co2.pct   = s.atmosphere.co2Pct;

        game.systems.o2.active = s.o2Generator.active;
        game.systems.o2.count  = s.o2Generator.count;
        game.systems.o2.tier   = s.o2Generator.tier;
        game.systems.o2.target = s.o2Generator.target ?? 21.0;
        game.systems.o2.repairPct  = s.o2Generator.repairPct ?? 100;
        game.systems.o2.juryRigged = s.o2Generator.juryRigged ?? false;
        game.systems.o2.destroyed  = s.o2Generator.destroyed ?? false;

        game.systems.co2.active  = s.co2Scrubber.active;
        game.systems.co2.count   = s.co2Scrubber.count;
        game.systems.co2.tier    = s.co2Scrubber.tier;
        game.systems.co2.target  = s.co2Scrubber.target ?? 0.04;
        game.systems.co2.repairPct  = s.co2Scrubber.repairPct ?? 100;
        game.systems.co2.juryRigged = s.co2Scrubber.juryRigged ?? false;
        game.systems.co2.destroyed  = s.co2Scrubber.destroyed ?? false;

        game.systems.power.current  = s.battery.currentWh;
        game.systems.power.capacity = s.battery.capacityWh;
        game.systems.power.count    = s.battery.count;
        game.systems.power.tier     = s.battery.tier;
        game.systems.power.active   = s.generator.active;
        game.systems.power.level    = (s.battery.currentWh / s.battery.capacityWh) * 100;
        game.systems.power.target   = s.battery.target ?? 80.0;
        game.systems.power.repairPct  = s.generator.repairPct ?? 100;
        game.systems.power.juryRigged = s.generator.juryRigged ?? false;
        game.systems.power.destroyed  = s.generator.destroyed ?? false;

        game.systems.fuel.current  = s.fuel.currentL;
        game.systems.fuel.capacity = s.fuel.capacityL;
        game.systems.fuel.level    = (s.fuel.currentL / s.fuel.capacityL) * 100;
    }

    // v1.0.0 inline-systems format (legacy support).
    static _restoreLegacy(game, snap) {
        game.gameTime  = snap.world.gameTime;
        game.credits   = snap.world.credits;
        game.gameSpeed = snap.world.gameSpeed;
        game.crew      = snap.crew.count;
        game.shipInstanceId = 'player-ship-1';

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

        // Legacy saves predate repair state — start fresh.
        game.systems.o2.repairPct    = 100; game.systems.o2.juryRigged    = false; game.systems.o2.destroyed    = false;
        game.systems.co2.repairPct   = 100; game.systems.co2.juryRigged   = false; game.systems.co2.destroyed   = false;
        game.systems.power.repairPct = 100; game.systems.power.juryRigged = false; game.systems.power.destroyed = false;
        game.repairQueue = [];
    }

    // ── Server-side save (requires: node server.js) ───────────────────────

    static async saveServer(game) {
        // Load current ship instances so we can update just this ship's state.
        let existingInstances = null;
        try {
            const r = await fetch('/api/ship-instances');
            if (r.ok) existingInstances = await r.json();
        } catch { /* first save — file may not exist yet */ }

        const snap      = GameState.snapshot(game);
        const instances = GameState.shipInstanceSnapshot(game, existingInstances);

        const [saveResp, instanceResp] = await Promise.all([
            fetch('/api/save', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(snap, null, 2),
            }),
            fetch('/api/ship-instances', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(instances, null, 2),
            }),
        ]);

        if (!saveResp.ok)     throw new Error('Save failed — server responded ' + saveResp.status);
        if (!instanceResp.ok) throw new Error('Ship save failed — server responded ' + instanceResp.status);
        return snap;
    }

    static async loadServer(game) {
        const [saveResp, instanceResp] = await Promise.all([
            fetch('/api/save'),
            fetch('/api/ship-instances'),
        ]);

        if (saveResp.status === 404) throw new Error('No save file found.');
        if (!saveResp.ok) throw new Error('Server responded ' + saveResp.status);

        const snap     = await saveResp.json();
        const instances = instanceResp.ok ? await instanceResp.json() : null;

        GameState.restore(game, snap, instances);
    }

    static async hasSaveServer() {
        try {
            const resp = await fetch('/api/save', { method: 'HEAD' });
            return resp.ok;
        } catch { return false; }
    }

    // ── File I/O (portable) ───────────────────────────────────────────────
    // Exports world state + embedded ship system state in one file.

    static exportFile(game) {
        const snap = GameState.snapshot(game);
        const s    = game.systems;
        snap.shipSystemState = {
            atmosphere:  { o2Pct: s.o2.pct, co2Pct: s.co2.pct },
            o2Generator: { active: s.o2.active, count: s.o2.count, tier: s.o2.tier, target: s.o2.target ?? 21.0,
                           repairPct: s.o2.repairPct ?? 100, juryRigged: s.o2.juryRigged ?? false, destroyed: s.o2.destroyed ?? false },
            co2Scrubber: { active: s.co2.active, count: s.co2.count, tier: s.co2.tier, target: s.co2.target ?? 0.04,
                           repairPct: s.co2.repairPct ?? 100, juryRigged: s.co2.juryRigged ?? false, destroyed: s.co2.destroyed ?? false },
            battery:     { currentWh: s.power.current, capacityWh: s.power.capacity, count: s.power.count, tier: s.power.tier, target: s.power.target ?? 80.0 },
            generator:   { active: s.power.active,
                           repairPct: s.power.repairPct ?? 100, juryRigged: s.power.juryRigged ?? false, destroyed: s.power.destroyed ?? false },
            fuel:        { currentL: s.fuel.current, capacityL: s.fuel.capacity },
        };
        snap.repairQueue = game.repairQueue ?? [];

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
        const input    = document.createElement('input');
        input.type     = 'file';
        input.accept   = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const snap = JSON.parse(ev.target.result);
                    // Exported files embed ship system state directly
                    const pseudoInstances = snap.shipSystemState
                        ? { ships: [{ id: snap.shipInstanceId ?? 'player-ship-1', name: game.shipName, registration: game.shipRegistration, systemState: snap.shipSystemState, repairQueue: snap.repairQueue ?? [] }] }
                        : null;
                    GameState.restore(game, snap, pseudoInstances);
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
