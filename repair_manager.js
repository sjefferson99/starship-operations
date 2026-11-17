// Repair domain logic: module wear, the repair-level → output curve, staged
// repairs, and the crew-limited repair task queue. Physics (system_update.js)
// only consumes efficiencyFor().
//
// The queue is the ship's whole work queue: fabrication jobs (fabrication.js,
// `kind: 'fabricate'`) sit in it alongside repairs and are worked by the same
// engineers in the same priority order.
//
// REPAIR STAGES are the tuning dials, set per module (and tier) in
// data/module_specs.json as `repairStages` — an ordered list, each entry one
// rung of the ladder from wrecked to perfect:
//
//   { "name": "Rebuild", "toPct": 50, "efficiency": 0.40, "hours": 5 }
//
//   toPct         where the stage ends (it starts where the previous one ended,
//                 or at 0) — i.e. where the repair sections are
//   efficiency    the fraction of rated output the module gives at toPct —
//                 i.e. what functionality completing the stage gets you back
//   hours         crew-hours to complete the whole stage — how hard it is
//   destroyChance (optional) chance the attempt wrecks the module for good
//   juryRig       (optional) the stage is a bodge: the module comes out
//                 jury-rigged and wears `juryRigWearMultiplier` times faster
//                 until a later, proper stage is completed
//
// Repairs land in chunks: nothing improves while a stage is being worked, then
// the module jumps to that stage's toPct when it completes. Between stage
// boundaries (which is where wear leaves a module) output is interpolated
// linearly, so wear still degrades it smoothly.

class RepairManager {
    static _taskSeq = 0; // makes task ids unique within a page session

    constructor(game) {
        this.game = game;

        // A module this close to perfect isn't worth a repair task.
        this.REPAIR_AVAILABLE_BELOW_PCT = 95;

        // Used only until data/module_specs.json has loaded (or for a module
        // with no stages defined).
        this.DEFAULT_STAGES = [
            { name: 'Salvage',  toPct: 20,  efficiency: 0.10, hours: 6, destroyChance: 0.2, juryRig: true },
            { name: 'Rebuild',  toPct: 50,  efficiency: 0.40, hours: 5 },
            { name: 'Overhaul', toPct: 80,  efficiency: 0.80, hours: 3 },
            { name: 'Tune-up',  toPct: 100, efficiency: 1.00, hours: 2 },
        ];
        this.DEFAULT_JURY_RIG_WEAR_MULTIPLIER = 10;
    }

    // ── Module spec lookup ──────────────────────────────────────────────────
    _spec(moduleType, tier) {
        const modules = this.game.moduleSpecs && this.game.moduleSpecs.modules;
        return modules && modules[moduleType] && modules[moduleType][String(tier)];
    }

    // Every function here that takes a `systemKey` takes a UNIT KEY: either a
    // fitted module's key in game.systems ('o2', 'waterMaker', …) or
    // 'box:<boxId>' for a module stored in a machine box (fabrication.js).
    // Repair tasks carry the unit key as their `systemKey`, so a stored unit's
    // repair is worked like any other — and the dashboard, which only ever
    // looks for fitted keys, never mistakes it for the fitted module's.
    isStoredUnit(systemKey) {
        return typeof systemKey === 'string' && systemKey.startsWith('box:');
    }

    // Map a unit key to the module type used in module_specs.json.
    _moduleType(systemKey) {
        const key = this.isStoredUnit(systemKey) ? this._sys(systemKey)?.moduleKey : systemKey;
        if (key === 'o2')    return 'o2Generator';
        if (key === 'co2')   return 'co2Scrubber';
        if (key === 'power') return 'generator';
        return key;
    }

    _sys(systemKey) {
        if (this.isStoredUnit(systemKey)) return this.game.fabrication.storedModule(systemKey.slice(4));
        return this.game.systems[systemKey];
    }

    _specFor(systemKey) {
        const sys = this._sys(systemKey);
        return sys ? this._spec(this._moduleType(systemKey), sys.tier) : null;
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

    // Unit keys of modules stored in machine boxes. They can be repaired but,
    // switched off in a box, never wear — so decay() doesn't see them.
    storedKeys() {
        return this.game.fabrication.storedUnitKeys();
    }

    // ── Stages ──────────────────────────────────────────────────────────────

    // The module's stages, sorted, each with its implied starting point filled in.
    stages(systemKey) {
        const spec = this._specFor(systemKey);
        const raw  = (spec && Array.isArray(spec.repairStages) && spec.repairStages.length)
            ? spec.repairStages
            : this.DEFAULT_STAGES;
        let fromPct = 0, fromEfficiency = 0;
        return raw.slice().sort((a, b) => a.toPct - b.toPct).map(stage => {
            const full = { ...stage, fromPct, fromEfficiency };
            fromPct = stage.toPct; fromEfficiency = stage.efficiency;
            return full;
        });
    }

    // The stage a module at `pct` is currently in (the next one to complete).
    stageFor(systemKey, pct) {
        const stages = this.stages(systemKey);
        return stages.find(s => s.toPct > pct) ?? stages[stages.length - 1];
    }

    // Hours to finish `stage` starting from `pct` — a module partway up a
    // stage needs proportionally less work to complete it.
    _stageHoursFrom(stage, pct) {
        const span = stage.toPct - stage.fromPct;
        const left = Math.max(0, Math.min(span, stage.toPct - pct));
        return span > 0 ? stage.hours * (left / span) : 0;
    }

    // ── Output curve ────────────────────────────────────────────────────────
    // Fraction of rated output at the module's current repair level: linear
    // between the stage boundaries defined in its spec.
    efficiencyAt(systemKey, repairPct) {
        const pct    = Math.max(0, Math.min(100, repairPct ?? 100));
        const stages = this.stages(systemKey);
        const stage  = stages.find(s => s.toPct >= pct) ?? stages[stages.length - 1];
        const span   = stage.toPct - stage.fromPct;
        const t      = span > 0 ? Math.min(1, (pct - stage.fromPct) / span) : 1;
        return stage.fromEfficiency + (stage.efficiency - stage.fromEfficiency) * t;
    }

    efficiencyFor(systemKey) {
        const sys = this._sys(systemKey);
        if (!sys || sys.destroyed) return 0;
        return this.efficiencyAt(systemKey, sys.repairPct);
    }

    // ── Decay ────────────────────────────────────────────────────────────────
    // Only wears down while the module is switched on — idle modules don't
    // deteriorate yet (no separate "sitting unused" decay model for now).
    decay(dt) {
        this.repairableKeys().forEach(systemKey => {
            const sys = this._sys(systemKey);
            if (!sys || sys.destroyed || !sys.active) return;

            const spec = this._specFor(systemKey);
            const juryMultiplier = (spec && spec.juryRigWearMultiplier) ?? this.DEFAULT_JURY_RIG_WEAR_MULTIPLIER;
            const ratePerHr = (spec ? spec.degradationPctPerHr : 0.14) * (sys.juryRigged ? juryMultiplier : 1);
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

    // ── What a repair would involve ─────────────────────────────────────────

    canRepair(systemKey) {
        const sys = this._sys(systemKey);
        if (!sys || sys.destroyed || sys.installed === false) return false;
        if ((sys.repairPct ?? 100) >= this.REPAIR_AVAILABLE_BELOW_PCT) return false;
        return !this.game.repairQueue.some(t => t.systemKey === systemKey);
    }

    // Every level a repair of this module could be told to stop at — the top
    // of each stage above where it is now — with the total hours to get there,
    // the output it would then give, and the worst destroy risk on the way.
    // For a module already being repaired, hours count from the task's progress.
    targetOptions(systemKey) {
        const sys = this._sys(systemKey);
        if (!sys) return [];
        const pct  = sys.repairPct ?? 100;
        const task = this.game.repairQueue.find(t => t.systemKey === systemKey);
        const all  = this.stages(systemKey);
        const current = task ? this._taskStage(task) : this.stageFor(systemKey, pct);
        const ahead   = all.filter(s => s.toPct >= current.toPct);

        let hours = 0, risk = 0;
        return ahead.map((stage, i) => {
            hours += i === 0 ? (task ? task.hoursRemaining : this._stageHoursFrom(stage, pct)) : stage.hours;
            risk   = Math.max(risk, stage.destroyChance ?? 0);
            return { targetPct: stage.toPct, hours, efficiency: stage.efficiency, destroyChance: risk, stageName: stage.name };
        });
    }

    // The option for `targetPct` (or the furthest one if that isn't on offer).
    describeRepair(systemKey, targetPct) {
        const options = this.targetOptions(systemKey);
        if (!options.length) return null;
        return options.find(o => o.targetPct === targetPct) ?? options[options.length - 1];
    }

    // ── Queue management ────────────────────────────────────────────────────

    // Queues a repair that will work up through the stages and stop once the
    // module reaches `targetPct` (defaults to a full repair).
    startRepair(systemKey, targetPct) {
        if (!this.canRepair(systemKey)) return null;
        const sys    = this._sys(systemKey);
        const target = this.describeRepair(systemKey, targetPct);
        if (!target) return null;

        const stage = this.stageFor(systemKey, sys.repairPct ?? 100);
        const hours = this._stageHoursFrom(stage, sys.repairPct ?? 100);
        const task = {
            // Unique id without a roll, so queueing a task doesn't use up a gameplay roll.
            id: `task-${Date.now().toString(36)}-${++RepairManager._taskSeq}`,
            systemKey,
            targetPct: target.targetPct,
            band: stage.name,          // the stage currently being worked
            totalHours: hours,         // …and its hours (not the whole repair's)
            hoursRemaining: hours,
            status: 'queued',
        };
        this.game.repairQueue.push(task);
        return task;
    }

    // Change where a queued/in-progress repair will stop. It can't be set
    // below the stage already being worked on.
    setTaskTarget(taskId, targetPct) {
        const task = this.game.repairQueue.find(t => t.id === taskId);
        if (!task) return false;
        const option = this.targetOptions(task.systemKey).find(o => o.targetPct === targetPct);
        if (!option) return false;
        task.targetPct = option.targetPct;
        return true;
    }

    // Hours of work left on a task across every stage up to its target.
    remainingHours(task) {
        if (task.kind === 'fabricate') return task.hoursRemaining;
        const options = this.targetOptions(task.systemKey);
        const option  = options.find(o => o.targetPct === task.targetPct) ?? options[options.length - 1];
        return option ? option.hours : task.hoursRemaining;
    }

    _taskStage(task) {
        const stages = this.stages(task.systemKey);
        return stages.find(s => s.name === task.band) ??
               this.stageFor(task.systemKey, this._sys(task.systemKey).repairPct ?? 100);
    }

    cancelTask(taskId) {
        const idx = this.game.repairQueue.findIndex(t => t.id === taskId);
        if (idx === -1) return false;
        const [task] = this.game.repairQueue.splice(idx, 1);
        if (task.kind === 'fabricate') this.game.fabrication.refund(task);
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
            let workHours = (dt / 3600) / factor;

            // One big tick can finish a stage and carry on into the next.
            while (task.status !== 'done') {
                if (workHours < task.hoursRemaining) { task.hoursRemaining -= workHours; break; }
                workHours -= task.hoursRemaining;
                task.hoursRemaining = 0;
                // Fabrication jobs share the queue and the crew; they're one stage long.
                if (task.kind === 'fabricate') this.game.fabrication.completeTask(task);
                else this._completeStage(task);
            }
        });

        // Remove completed tasks (those resolved in _completeStage are flagged 'done').
        this.game.repairQueue = queue.filter(t => t.status !== 'done');
    }

    // The stage being worked is finished: the module jumps up to it (or is
    // wrecked by a failed risky stage). The task then either ends — target
    // reached — or moves on to the next stage.
    _completeStage(task) {
        const sys   = this._sys(task.systemKey);
        const stage = this._taskStage(task);

        if (stage.destroyChance && this.game.rng.next() < stage.destroyChance) {
            sys.destroyed = true;
            sys.active = false;
            sys.repairPct = 0;
            task.status = 'done';
            return;
        }

        sys.repairPct  = Math.max(sys.repairPct ?? 0, stage.toPct);
        sys.juryRigged = !!stage.juryRig; // a proper stage replaces an earlier bodge

        const next = this.stages(task.systemKey).find(s => s.toPct > stage.toPct);
        if (!next || sys.repairPct >= (task.targetPct ?? 100)) {
            task.status = 'done';
            return;
        }
        task.band           = next.name;
        task.totalHours     = next.hours;
        task.hoursRemaining = next.hours;
    }
}
