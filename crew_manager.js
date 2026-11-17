// Crew health & roster: owns the live crew list (merged from the read-only
// data/crew_manifest.json template + per-save health/shift/death state),
// the environment-driven health curve, and the resulting work effectiveness.
// RepairManager consumes isAvailable()/effectivenessMultiplier(); SystemUpdate
// drives update(dt) once per tick.

class CrewManager {
    constructor(game) {
        this.game = game;

        this.BASE_RATE_PCT_PER_HR = 15; // health gain/loss per hour at severity 1 (or recovering)
        this.UNCONSCIOUS_THRESHOLD = 20;
        this.WARNING_THRESHOLD    = 80;
        this.EFFECTIVENESS_K      = 3 / 6400; // timeFactor = 1 + K*(100-health)^2

        // Fresh water deprivation: no health impact for the first 24h the tank
        // reads empty, then a dedicated decline rate (independent of BASE_RATE_PCT_PER_HR)
        // calibrated to take a member from full health to 0 over the next 24h.
        this.WATER_GRACE_HOURS            = 24;
        this.WATER_DEPRIVATION_PCT_PER_HR = 100 / 24;

        // Rationing trades water savings for a slow health cost: harmless for the
        // first 24h, then a fraction of the full-dehydration rate. Superseded by
        // full dehydration above if the tank actually runs dry while rationing.
        this.WATER_RATION_GRACE_HOURS    = 24;
        this.WATER_RATION_HEALTH_FRACTION = 0.10;

        // Overwork, driven by how many hours a day a member is *scheduled* on
        // duty (not by whether there happened to be a task to do):
        //   up to 8h   — no effect.
        //   8–12h      — no health cost, but work gets a little slower each extra hour.
        //   over 12h   — health is worn down toward a ceiling that drops, faster
        //                than linearly, with every further hour. 16h settles
        //                around 80%, 20h around 45% (sustainable, but deep in the
        //                slow-working "critical" band), 22h hovers at the edge of
        //                collapse, and 24h has a ceiling of 0 — death in ~3 days.
        this.FATIGUE_FREE_HOURS      = 8;
        this.FATIGUE_OK_HOURS        = 12;
        this.FATIGUE_SLOWDOWN_PER_HR = 0.05;      // +5% task time per scheduled hour over 8, up to 12
        this.FATIGUE_CURVE           = 1.5;       // exponent on the 12→24h overwork fraction
        this.FATIGUE_MAX_PCT_PER_HR  = 100 / 72;  // decline rate at 24h/day: full health to dead in 3 days

        // Sewage exposure while the black water tank is full: an immediate
        // drain that steepens the longer it's left, plus a rising chance each
        // hour of a member picking up an infection (a one-off lump of damage).
        this.SEWAGE_BASE_PCT_PER_HR       = 1.0;
        this.SEWAGE_GROWTH_PCT_PER_HR2    = 0.5;  // extra %/hr of drain per hour of exposure
        this.SEWAGE_MAX_PCT_PER_HR        = 10;
        this.INFECTION_CHANCE_PER_HR2     = 0.03; // hourly chance grows by this per hour of exposure
        this.INFECTION_MAX_CHANCE_PER_HR  = 0.5;
        this.INFECTION_DAMAGE_PCT         = 15;

        this._pendingSavedMembers = null; // saved roster received before the template finished loading
    }

    // ── Overwork / fatigue ──────────────────────────────────────────────────

    // Hours per day this member is scheduled on duty — overlapping shifts are
    // only counted once.
    dutyHours(member) {
        const spans = (member.shifts || [])
            .map(s => [Math.max(0, s.startHour), Math.min(24, s.endHour)])
            .filter(([a, b]) => b > a)
            .sort((a, b) => a[0] - b[0]);
        let total = 0, coveredTo = 0;
        spans.forEach(([a, b]) => {
            const from = Math.max(a, coveredTo);
            if (b > from) { total += b - from; coveredTo = b; }
        });
        return total;
    }

    // 0 at ≤12h/day, rising to 1 at 24h/day.
    _overworkFraction(member) {
        const over = this.dutyHours(member) - this.FATIGUE_OK_HOURS;
        if (over <= 0) return 0;
        return Math.pow(Math.min(1, over / (24 - this.FATIGUE_OK_HOURS)), this.FATIGUE_CURVE);
    }

    // The highest health this member can hold on their current schedule.
    fatigueHealthCap(member) {
        return 100 * (1 - this._overworkFraction(member));
    }

    fatigueRatePctPerHr(member) {
        return this.FATIGUE_MAX_PCT_PER_HR * this._overworkFraction(member);
    }

    // Multiplier on task time from long (but not yet harmful) hours.
    fatigueWorkFactor(member) {
        const extra = Math.min(this.dutyHours(member), this.FATIGUE_OK_HOURS) - this.FATIGUE_FREE_HOURS;
        return 1 + this.FATIGUE_SLOWDOWN_PER_HR * Math.max(0, extra);
    }

    // One-line schedule summary for the crew screen.
    dutySummary(member) {
        const hours = this.dutyHours(member);
        const label = `On duty ${+hours.toFixed(1)}h/day`;
        if (hours <= this.FATIGUE_FREE_HOURS) return { level: 'normal', text: label };
        if (hours <= this.FATIGUE_OK_HOURS) {
            const slower = Math.round((this.fatigueWorkFactor(member) - 1) * 100);
            return { level: 'warning', text: `${label} — long hours, working ${slower}% slower` };
        }
        const cap = this.fatigueHealthCap(member);
        return {
            level: 'critical',
            text: cap <= 0
                ? `${label} — no rest at all: this will kill them within days`
                : `${label} — overworked: health is being worn down to ${Math.round(cap)}%`,
        };
    }

    // Crew who are on shift right now with no task to work on, despite being
    // rostered for more than the fatigue-free 8 hours a day — the people who
    // would reasonably complain. Uses the same positional pairing as
    // RepairManager.processQueue: the Nth on-shift engineer works the Nth task.
    idleOverScheduled() {
        const queueLength = this.game.repairQueue.length;
        return this.game.repairManager.crewOnShift()
            .filter((member, i) => i >= queueLength && this.dutyHours(member) > this.FATIGUE_FREE_HOURS);
    }

    // ── Sewage exposure ─────────────────────────────────────────────────────

    _sewageExposureHours() {
        return this.game.systems.blackWater?.exposureHours || 0;
    }

    _sewageRatePctPerHr() {
        const hours = this._sewageExposureHours();
        if (hours <= 0) return 0;
        return Math.min(this.SEWAGE_MAX_PCT_PER_HR, this.SEWAGE_BASE_PCT_PER_HR + this.SEWAGE_GROWTH_PCT_PER_HR2 * hours);
    }

    infectionChancePerHr() {
        return Math.min(this.INFECTION_MAX_CHANCE_PER_HR, this.INFECTION_CHANCE_PER_HR2 * this._sewageExposureHours());
    }

    // ── Roster lifecycle ────────────────────────────────────────────────────

    _freshMember(tpl) {
        return {
            id: tpl.id,
            classes: tpl.classes,
            shifts: tpl.shifts.map(s => ({ ...s })),
            health: 100,
            varianceFactor: 0.7 + this.game.rng.next() * 0.6,
            dead: false,
        };
    }

    // New game: ignore any prior live state, rebuild fresh from the template.
    resetRoster() {
        this.game.crewManifest = (this.game.crewManifestTemplate || []).map(tpl => this._freshMember(tpl));
        this._pendingSavedMembers = null;
    }

    // Template finished (re)loading — merge it into whatever live roster
    // already exists (preserving health/shifts/variance), or apply a saved
    // roster that arrived before the template did.
    syncRoster() {
        const template = this.game.crewManifestTemplate || [];
        const existing = this.game.crewManifest || [];
        const savedById = this._pendingSavedMembers
            ? new Map(this._pendingSavedMembers.map(m => [m.id, m]))
            : null;

        this.game.crewManifest = template.map(tpl => {
            const live  = existing.find(m => m.id === tpl.id);
            const saved = savedById && savedById.get(tpl.id);
            if (saved) {
                return {
                    id: tpl.id, classes: tpl.classes,
                    shifts: (saved.shifts ?? tpl.shifts).map(s => ({ ...s })),
                    health: saved.health ?? 100,
                    varianceFactor: saved.varianceFactor ?? (0.7 + this.game.rng.next() * 0.6),
                    dead: saved.dead ?? false,
                };
            }
            if (live) return { ...live, classes: tpl.classes };
            return this._freshMember(tpl);
        });
        this._pendingSavedMembers = null;
    }

    // Loading a save: rehydrate health/variance/shifts/dead. If the template
    // hasn't finished loading yet, stash it — syncRoster() will pick it up.
    applySavedRoster(savedMembers) {
        const template = this.game.crewManifestTemplate || [];
        if (!template.length) {
            this._pendingSavedMembers = savedMembers ?? [];
            return;
        }
        this._pendingSavedMembers = savedMembers ?? [];
        this.syncRoster();
    }

    // ── Environment severity ────────────────────────────────────────────────
    // Continuous 0..1+ per factor, ramping across the same thresholds the
    // dashboard badges use (SystemUpdate._updateStatuses), summed so multiple
    // bad factors stack.

    _o2Severity() {
        const pct = this.game.systems.o2.pct;
        if (pct >= 19.5) return 0;
        if (pct >= 16) return ((19.5 - pct) / (19.5 - 16)) * 0.3;
        return 0.3 + (Math.min(16, 16 - pct) / 16) * 0.7;
    }

    _co2Severity() {
        const ppm = this.game.systems.co2.pct * 10000;
        if (ppm <= 1000) return 0;
        if (ppm <= 5000) return ((ppm - 1000) / (5000 - 1000)) * 0.3;
        return 0.3 + (Math.min(5000, ppm - 5000) / 5000) * 0.7;
    }

    // Single source of truth for "what's currently hurting the crew, and how
    // much" — feeds both the per-tick health delta below and the crew-screen
    // breakdown panel, so the two can never drift apart. Each entry's rate is
    // the decline at varianceFactor 1; update() scales it per member.
    healthImpactBreakdown() {
        const items = [];

        const o2Sev  = this._o2Severity();
        const co2Sev = this._co2Severity();
        if (o2Sev > 0)  items.push({ label: 'Oxygen deprivation', ratePctPerHr: o2Sev  * this.BASE_RATE_PCT_PER_HR });
        if (co2Sev > 0) items.push({ label: 'CO2 toxicity',       ratePctPerHr: co2Sev * this.BASE_RATE_PCT_PER_HR });

        const fresh = this.game.systems.freshWater;
        if (fresh) {
            if ((fresh.depletedHours || 0) > this.WATER_GRACE_HOURS) {
                items.push({ label: 'Dehydration (no fresh water)', ratePctPerHr: this.WATER_DEPRIVATION_PCT_PER_HR });
            } else if (fresh.rationing && (fresh.rationHours || 0) > this.WATER_RATION_GRACE_HOURS) {
                items.push({ label: 'Water rationing strain', ratePctPerHr: this.WATER_RATION_HEALTH_FRACTION * this.WATER_DEPRIVATION_PCT_PER_HR });
            }
        }

        const sewageRate = this._sewageRatePctPerHr();
        if (sewageRate > 0) {
            const chance = Math.round(this.infectionChancePerHr() * 100);
            items.push({
                label: `Sewage exposure (black water tank full${chance > 0 ? `, ${chance}%/hr infection risk` : ''})`,
                ratePctPerHr: sewageRate,
            });
        }

        return items;
    }

    // ── Health update ───────────────────────────────────────────────────────
    // Ship-wide environment factors (above) hit everyone; overwork is per
    // member, from their own shift schedule. With nothing wrong a member
    // recovers — but only as far as their schedule's fatigue ceiling allows.

    update(dt) {
        const hours = dt / 3600;
        const totalDeclineRate = this.healthImpactBreakdown()
            .reduce((sum, item) => sum + item.ratePctPerHr, 0);

        // Chance of at least one infection over this tick, however long the tick is.
        const infectionChance = 1 - Math.pow(1 - this.infectionChancePerHr(), hours);

        (this.game.crewManifest || []).forEach(member => {
            if (member.dead) return;

            const cap = this.fatigueHealthCap(member);
            let health = member.health;

            if (totalDeclineRate > 0) {
                health -= totalDeclineRate * member.varianceFactor * hours;
            } else if (health < cap) {
                health = Math.min(cap, health + this.BASE_RATE_PCT_PER_HR * member.varianceFactor * hours);
            }

            // Overwork only ever pulls health down *to* the ceiling, never through it.
            if (health > cap) {
                health = Math.max(cap, health - this.fatigueRatePctPerHr(member) * member.varianceFactor * hours);
            }

            if (infectionChance > 0 && this.game.rng.next() < infectionChance) {
                health -= this.INFECTION_DAMAGE_PCT;
                // No lasting state marks an infection, so it is reported here rather than spotted later.
                const index = (this.game.crewManifest || []).indexOf(member);
                this.game.notifications?.add({
                    key: `infection:${member.id}`, level: 'critical',
                    title: `Crew ${index + 1} has caught an infection`,
                    detail: `Sewage in the cabin: −${this.INFECTION_DAMAGE_PCT}% health. Dump the black water tank.`,
                });
            }

            member.health = Math.max(0, Math.min(100, health));
            if (member.health <= 0) {
                member.health = 0;
                member.dead = true;
            }
        });
    }

    // ── Effectiveness / availability ────────────────────────────────────────

    effectivenessMultiplier(health) {
        const deficit = 100 - Math.max(0, Math.min(100, health));
        return 1 + this.EFFECTIVENESS_K * deficit * deficit;
    }

    isAvailable(member) {
        return !member.dead && member.health >= this.UNCONSCIOUS_THRESHOLD;
    }

    aliveCount() {
        return (this.game.crewManifest || []).filter(m => !m.dead).length;
    }

    // ── Status / display helpers ────────────────────────────────────────────

    statusFor(member) {
        if (member.dead) return 'dead';
        if (member.health < this.UNCONSCIOUS_THRESHOLD) return 'unconscious';
        if (member.health < 50) return 'critical';
        if (member.health < this.WARNING_THRESHOLD) return 'warning';
        return 'normal';
    }

    worstStatus() {
        const order = ['dead', 'unconscious', 'critical', 'warning', 'normal'];
        const statuses = (this.game.crewManifest || []).map(m => this.statusFor(m));
        for (const s of order) if (statuses.includes(s)) return s;
        return 'normal';
    }
}
