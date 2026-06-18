// GameState — serialise / restore the entire game as a plain JSON object.
//
// Persistence backends:
//   listSaves / createSave / deleteSave / saveServer / loadServer — REST API via node server.js,
//     backed by SQLite (see db.js) — each save is a named slot, identified by game.saveId.
//   exportFile / importFile — portable .json file download/upload (independent of saved slots)

class GameState {
    static VERSION = '2.0.0';

    // World-state snapshot (no ship systems — those live in shipInstanceSnapshot).
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

    // Ship instance state snapshot — each save owns exactly one ship, so this is
    // always a fresh single-ship array (no merging with any other save's data).
    static shipInstanceSnapshot(game) {
        const s = game.systems;
        const systemState = {
            atmosphere: {
                o2Pct:  s.o2.pct,
                co2Pct: s.co2.pct,
            },
            o2Generator: {
                active: s.o2.active, count: s.o2.count, tier: s.o2.tier, target: s.o2.target ?? 21.0,
                repairPct: s.o2.repairPct ?? 100, juryRigged: s.o2.juryRigged ?? false, destroyed: s.o2.destroyed ?? false,
            },
            co2Scrubber: {
                active: s.co2.active, count: s.co2.count, tier: s.co2.tier, target: s.co2.target ?? 0.04,
                repairPct: s.co2.repairPct ?? 100, juryRigged: s.co2.juryRigged ?? false, destroyed: s.co2.destroyed ?? false,
            },
            battery: {
                currentWh: s.power.current, capacityWh: s.power.capacity,
                count: s.power.count, tier: s.power.tier, target: s.power.target ?? 80.0,
            },
            generator: {
                active: s.power.active,
                repairPct: s.power.repairPct ?? 100, juryRigged: s.power.juryRigged ?? false, destroyed: s.power.destroyed ?? false,
            },
            fuel: {
                currentL: s.fuel.current, capacityL: s.fuel.capacity,
            },
        };

        return {
            version: '1.0.0',
            ships: [{
                id: game.shipInstanceId ?? 'player-ship-1',
                name: game.shipName,
                registration: game.shipRegistration,
                systemState,
                repairQueue: game.repairQueue ?? [],
            }],
        };
    }

    // Apply a world snapshot + ship instance data back onto a live game instance.
    static restore(game, world, shipInstances) {
        if (!world || !world.world) {
            throw new Error(`Unrecognised save format (version "${world?.version ?? 'unknown'}")`);
        }

        game.gameTime  = world.world.gameTime;
        game.credits   = world.world.credits;
        game.gameSpeed = world.world.gameSpeed;
        game.crew      = world.crew.count;
        game.shipInstanceId = world.shipInstanceId ?? 'player-ship-1';

        game.inBreathableAtmosphere = world.environment?.inBreathableAtmosphere ?? false;
        game.ventsOpen              = world.environment?.ventsOpen              ?? false;

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

    // ── Save slots (requires: node server.js) ──────────────────────────────

    static async listSaves() {
        const resp = await fetch('/api/saves');
        if (!resp.ok) throw new Error('Could not list saves — server responded ' + resp.status);
        return resp.json();
    }

    // Creates a new named save slot. Throws with `.nameTaken = true` if the name
    // is already in use (server responds 409).
    static async createSave(name) {
        const resp = await fetch('/api/saves', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name }),
        });
        if (resp.status === 409) {
            const body = await resp.json().catch(() => ({}));
            const err = new Error(body.error ?? `A save named "${name}" already exists`);
            err.nameTaken = true;
            throw err;
        }
        if (!resp.ok) throw new Error('Could not create save — server responded ' + resp.status);
        return resp.json(); // { id }
    }

    static async deleteSave(id) {
        const resp = await fetch(`/api/saves/${id}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error('Could not delete save — server responded ' + resp.status);
    }

    static async saveServer(game) {
        const world         = GameState.snapshot(game);
        const shipInstances = GameState.shipInstanceSnapshot(game);

        const resp = await fetch(`/api/saves/${game.saveId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ world, shipInstances }, null, 2),
        });
        if (!resp.ok) throw new Error('Save failed — server responded ' + resp.status);
        return world;
    }

    static async loadServer(game, saveId) {
        const resp = await fetch(`/api/saves/${saveId}`);
        if (resp.status === 404) throw new Error('Save not found.');
        if (!resp.ok) throw new Error('Server responded ' + resp.status);

        const { world, shipInstances } = await resp.json();
        GameState.restore(game, world, shipInstances);
    }

    // ── File I/O (portable) ───────────────────────────────────────────────
    // Exports world state + embedded ship system state in one file.

    static exportFile(game) {
        const snap         = GameState.snapshot(game);
        const shipInstance = GameState.shipInstanceSnapshot(game).ships[0];
        snap.shipSystemState = shipInstance.systemState;
        snap.repairQueue     = shipInstance.repairQueue;

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
