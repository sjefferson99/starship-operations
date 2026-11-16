// Repair domain logic: module wear, efficiency curve, and the crew-limited
// repair task queue. Physics (system_update.js) only consumes efficiency().

class RepairManager {
    constructor(game) {
        this.game = game;
    }

    // ── Module spec lookup ──────────────────────────────────────────────────
    _spec(moduleType, tier) {
        const modules = this.game.moduleSpecs && this.game.moduleSpecs.modules;
        return modules && modules[moduleType] && modules[moduleType][String(tier)];
    }

    // Map a system key used in game.systems / ship_instances.json system blocks
    // to the module type used in module_specs.json.
    _moduleType(systemKey) {
        if (systemKey === 'o2')    return 'o2Generator';
        if (systemKey === 'co2')   return 'co2Scrubber';
        if (systemKey === 'power') return 'generator';
        return systemKey;
    }

    _sys(systemKey) {
        return this.game.systems[systemKey];
    }

    // Every system key that carries a repair level, in the order the Repair
    // Queue's "Available Repairs" list shows them. A module the ship doesn't
    // have fitted (installed === false — e.g. no water maker bought yet) is
    // skipped everywhere.
    repairableKeys() {
        return ['transceiver', 'power', 'o2', 'co2', 'waterMaker'].filter(key => {
            const sys = this._sys(key);
            return sys && sys.installed !== false;
        });
    }

    // ── Efficiency curve ─────────────────────────────────────────────────────
    // Quadratic: small early loss, catastrophic loss as repairPct nears 0.
    efficiency(repairPct, destroyed = false) {
        if (destroyed) return 0;
        const pct = Math.max(0, Math.min(100, repairPct ?? 100));
        return Math.pow(pct / 100, 2);
    }

    // ── Decay ────────────────────────────────────────────────────────────────
    // Only wears down while the module is switched on — idle modules don't
    // deteriorate yet (no separate "sitting unused" decay model for now).
    decay(dt) {
        this.repairableKeys().forEach(systemKey => {
            const sys = this._sys(systemKey);
            if (!sys || sys.destroyed || !sys.active) return;

            const spec = this._spec(this._moduleType(systemKey), sys.tier);
            const ratePerHr = (spec ? spec.degradationPctPerHr : 0.14) * (sys.juryRigged ? 10 : 1);
            sys.repairPct = Math.max(0, (sys.repairPct ?? 100) - (ratePerHr * dt) / 3600);
        });
    }

    // ── Crew shift lookup ────────────────────────────────────────────────────
    _currentHour() {
        const secInDay = this.game.gameTime % 86400;
        return Math.floor(secInDay / 3600) + (secInDay % 3600) / 3600;
    }

    crewOnShift() {
        const manifest = this.game.crewManifest || [];
        const hour = this._currentHour();
        return manifest.filter(member =>
            member.classes.includes('engineering') &&
            member.shifts.some(s => hour >= s.startHour && hour < s.endHour) &&
            this.game.crewManager.isAvailable(member)
        );
    }

    nextShiftChangeHour() {
        const manifest = this.game.crewManifest || [];
        const hour = this._currentHour();
        const boundaries = [];
        manifest.forEach(m => m.shifts.forEach(s => { boundaries.push(s.startHour); boundaries.push(s.endHour); }));
        const upcoming = boundaries.filter(h => h > hour).sort((a, b) => a - b);
        return upcoming.length ? upcoming[0] : null;
    }

    // ── Band selection ──────────────────────────────────────────────────────
    _bandFor(spec, repairPct) {
        if (repairPct < 20)  return 'replacement';
        if (repairPct < 50)  return 'major';
        return 'minor'; // 50-95 range; callers should not call this when >=95
    }

    canRepair(systemKey) {
        const sys = this._sys(systemKey);
        if (!sys || sys.destroyed || sys.installed === false) return false;
        if ((sys.repairPct ?? 100) >= 95) return false;
        return !this.game.repairQueue.some(t => t.systemKey === systemKey);
    }

    describeRepair(systemKey) {
        const sys = this._sys(systemKey);
        if (!sys) return null;
        const spec = this._spec(this._moduleType(systemKey), sys.tier);
        if (!spec) return null;
        const band = this._bandFor(spec, sys.repairPct ?? 100);
        return { band, ...spec.repair[band] };
    }

    // ── Queue management ────────────────────────────────────────────────────
    startRepair(systemKey) {
        if (!this.canRepair(systemKey)) return null;
        const sys = this._sys(systemKey);
        const spec = this._spec(this._moduleType(systemKey), sys.tier);
        if (!spec) return null;

        const band = this._bandFor(spec, sys.repairPct ?? 100);
        const bandSpec = spec.repair[band];

        const task = {
            id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            systemKey,
            band,
            totalHours: bandSpec.hours,
            hoursRemaining: bandSpec.hours,
            status: 'queued',
        };
        this.game.repairQueue.push(task);
        return task;
    }

    cancelTask(taskId) {
        const idx = this.game.repairQueue.findIndex(t => t.id === taskId);
        if (idx === -1) return false;
        this.game.repairQueue.splice(idx, 1);
        return true;
    }

    reorderTasks(orderedIds) {
        const byId = new Map(this.game.repairQueue.map(t => [t.id, t]));
        const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
        // Keep any tasks not present in orderedIds (defensive) appended at the end.
        this.game.repairQueue.forEach(t => { if (!orderedIds.includes(t.id)) reordered.push(t); });
        this.game.repairQueue = reordered;
    }

    processQueue(dt) {
        const queue = this.game.repairQueue;
        if (!queue.length) return;

        queue.forEach(t => { t.status = 'queued'; });

        const onShift = this.crewOnShift();
        const active = queue.slice(0, onShift.length);
        active.forEach(t => { t.status = 'in-progress'; });

        // Each active task is paired with whichever on-shift crew member is
        // "in" that slot this tick — not a persistent assignment, just who
        // currently determines that task's progress speed.
        active.forEach((task, i) => {
            const factor = this.game.crewManager.effectivenessMultiplier(onShift[i].health) *
                           this.game.crewManager.fatigueWorkFactor(onShift[i]);
            task.hoursRemaining -= (dt / 3600) / factor;
            if (task.hoursRemaining <= 0) {
                this._completeTask(task);
            }
        });

        // Remove completed tasks (those resolved in _completeTask are flagged 'done').
        this.game.repairQueue = queue.filter(t => t.status !== 'done');
    }

    _completeTask(task) {
        const sys = this._sys(task.systemKey);
        const spec = this._spec(this._moduleType(task.systemKey), sys.tier);
        const bandSpec = spec.repair[task.band];

        if (task.band === 'replacement') {
            if (Math.random() < bandSpec.destroyChance) {
                sys.destroyed = true;
                sys.active = false;
                sys.repairPct = 0;
            } else {
                sys.repairPct = bandSpec.restorePct;
                sys.juryRigged = true;
            }
        } else {
            sys.repairPct = bandSpec.restorePct;
        }

        task.status = 'done';
    }
}
