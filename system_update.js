// Physics simulation — called once per real-time tick with dt = game-seconds elapsed.
// All rates are in real physical units (L/hr, W) and are scaled by dt internally.

class SystemUpdate {
    constructor(game) {
        this.game = game;

        // ── Physical constants ──────────────────────────────────────────────
        this.SHIP_VOLUME_L = 16000; // 2×2×4 m³ = 16 m³ = 16,000 L

        // Human physiology at rest (per person)
        this.O2_CONSUMPTION_L_HR  = 15.0; // 250 mL/min × 60
        this.CO2_PRODUCTION_L_HR  = 12.0; // 200 mL/min × 60

        // Fallback device specs (index = tier - 1), used only if
        // data/module_specs.json hasn't finished loading yet.
        this.O2_GEN_L_HR_BY_TIER  = [22.5];
        this.CO2_SCR_L_HR_BY_TIER = [18.0];
        this.O2_DRAW_W_BY_TIER    = [21];
        this.CO2_DRAW_W_BY_TIER   = [21];
        this.GEN_OUTPUT_W    = 142;
        this.GEN_FUEL_L_HR   = 0.01;
    }

    // Reads a per-tier numeric field from the loaded module_specs.json,
    // falling back to the constructor defaults above if not yet loaded.
    _moduleField(moduleType, tier, field, fallback) {
        const modules = this.game.moduleSpecs && this.game.moduleSpecs.modules;
        const spec = modules && modules[moduleType] && modules[moduleType][String(tier)];
        return spec && spec[field] != null ? spec[field] : fallback;
    }

    // dt: game-seconds elapsed this tick (= gameSpeed × 1 real second)
    update(dt = 1) {
        this._updateO2(dt);
        this._updateCO2(dt);
        this._updatePowerAndFuel(dt);
        this.game.repairManager.decay(dt);
        this.game.repairManager.processQueue(dt);
        this._updateStatuses();

        if (this._isGameOver()) {
            this.game.endGame();
        }
    }

    _updateO2(dt) {
        const sys  = this.game.systems.o2;
        const crew = this.game.crew;

        const consumptionLhr = this.O2_CONSUMPTION_L_HR * crew;
        const ratedLhr       = this._moduleField('o2Generator', sys.tier, 'outputLhr', this.O2_GEN_L_HR_BY_TIER[sys.tier - 1] ?? 0);
        const efficiency     = this.game.repairManager.efficiency(sys.repairPct, sys.destroyed);
        const maxGenLhr      = ratedLhr * sys.count * efficiency;

        // Vent computed first — needed to calculate maintenance generation
        let ventLhr = 0;
        if (this.game.ventsOpen && this.game.inBreathableAtmosphere) {
            const O2_TARGET  = 21.0;
            const VENT_DRIFT = 50;
            const direction  = sys.pct < O2_TARGET ? 1 : 0; // only push up; never force-remove
            ventLhr = consumptionLhr + direction * VENT_DRIFT;
        }

        // Proportional generation: at/above setpoint throttle to exact maintenance
        // so net = 0 and display reads "Stable" rather than flickering.
        let generationLhr = 0;
        if (sys.active) {
            if (sys.target != null && sys.pct >= sys.target) {
                // Maintenance: gen = (crew draw) − (vent contribution), clamped to [0, max]
                generationLhr = Math.max(0, Math.min(consumptionLhr - ventLhr, maxGenLhr));
            } else {
                generationLhr = maxGenLhr; // below setpoint: full output
            }
        }

        // genFraction drives proportional power draw in _updatePowerAndFuel
        sys.genFraction = maxGenLhr > 0 ? generationLhr / maxGenLhr : 0;

        const netLhr   = generationLhr + ventLhr - consumptionLhr;
        const deltaPct = (netLhr * dt) / (this.SHIP_VOLUME_L * 36);

        sys.pct = Math.max(0, Math.min(30, sys.pct + deltaPct));

        sys.consumptionLhr = consumptionLhr;
        sys.generationLhr  = generationLhr;
        sys.ventLhr        = ventLhr;
        sys.netLhr         = netLhr;
    }

    _updateCO2(dt) {
        const sys  = this.game.systems.co2;
        const crew = this.game.crew;

        const productionLhr = this.CO2_PRODUCTION_L_HR * crew;
        const ratedLhr      = this._moduleField('co2Scrubber', sys.tier, 'outputLhr', this.CO2_SCR_L_HR_BY_TIER[sys.tier - 1] ?? 0);
        const efficiency    = this.game.repairManager.efficiency(sys.repairPct, sys.destroyed);
        const maxScrLhr     = ratedLhr * sys.count * efficiency;

        // Ambient/outside CO2 level — vents equalise the cabin toward this, not toward 0.
        const CO2_AMBIENT = 0.04;

        // Vent computed first
        let ventLhr = 0; // positive = removing CO2 from cabin
        if (this.game.ventsOpen && this.game.inBreathableAtmosphere) {
            const VENT_DRIFT = 40;
            const direction  = sys.pct > CO2_AMBIENT ? 1 : 0;
            ventLhr = productionLhr + direction * VENT_DRIFT;
        }

        // Proportional scrubbing: at/below setpoint throttle to exact maintenance
        let removalLhr = 0;
        if (sys.active) {
            if (sys.target != null && sys.pct <= sys.target) {
                // Maintenance: remove = (crew production) − (vent contribution), clamped
                removalLhr = Math.max(0, Math.min(productionLhr - ventLhr, maxScrLhr));
            } else {
                removalLhr = maxScrLhr; // above setpoint: full scrubbing
            }
        }

        sys.scrFraction = maxScrLhr > 0 ? removalLhr / maxScrLhr : 0;

        const netLhr   = productionLhr - removalLhr - ventLhr;
        const deltaPct = (netLhr * dt) / (this.SHIP_VOLUME_L * 36);
        let newPct = sys.pct + deltaPct;

        // A large tick (high game speed) shouldn't overshoot past the ambient level
        // everything above is pulling toward — snap to it instead of blowing through to 0.
        if (sys.pct > CO2_AMBIENT && newPct < CO2_AMBIENT) newPct = CO2_AMBIENT;

        sys.pct = Math.max(0, Math.min(10, newPct));

        sys.productionLhr = productionLhr;
        sys.removalLhr    = removalLhr;
        sys.ventLhr       = ventLhr;
        sys.netLhr        = netLhr;
    }

    _updatePowerAndFuel(dt) {
        const power = this.game.systems.power;
        const fuel  = this.game.systems.fuel;
        const o2    = this.game.systems.o2;
        const co2   = this.game.systems.co2;

        // Power draw scales with fraction of rated output each device is currently using
        const o2DrawWRated  = this._moduleField('o2Generator', o2.tier, 'powerDrawW', this.O2_DRAW_W_BY_TIER[o2.tier - 1] ?? 0);
        const co2DrawWRated = this._moduleField('co2Scrubber', co2.tier, 'powerDrawW', this.CO2_DRAW_W_BY_TIER[co2.tier - 1] ?? 0);
        const o2DrawW  = o2.active
            ? o2DrawWRated * o2.count * (o2.genFraction ?? 1)
            : 0;
        const co2DrawW = co2.active
            ? co2DrawWRated * co2.count * (co2.scrFraction ?? 1)
            : 0;
        const totalDrawW = o2DrawW + co2DrawW;

        // Proportional generator: at/above battery target throttle to cover exact draw
        // so net battery = 0 and display reads "Stable" rather than flickering.
        const ratedOutputW = this._moduleField('generator', power.tier, 'outputW', this.GEN_OUTPUT_W);
        const genEfficiency = this.game.repairManager.efficiency(power.repairPct, power.destroyed);
        const maxOutputW    = ratedOutputW * genEfficiency;
        const genRunning = power.active && !power.destroyed && fuel.current > 0;
        let genOutputW = 0;
        if (genRunning) {
            if (power.target != null && power.level >= power.target) {
                genOutputW = Math.min(totalDrawW, maxOutputW); // maintenance: exactly cover draw
            } else {
                genOutputW = maxOutputW; // below target: full (degraded) output
            }
        }

        const netW = genOutputW - totalDrawW;
        power.current = Math.max(0, Math.min(power.capacity, power.current + netW * dt / 3600));
        power.level   = (power.current / power.capacity) * 100;

        power.genOutputW = genOutputW;
        power.o2DrawW    = o2DrawW;
        power.co2DrawW   = co2DrawW;
        power.netWhr     = netW;

        // Fuel burn proportional to nominal (undamaged) rated output — a degraded
        // generator burns the same fuel per watt it can still produce.
        const genFraction   = ratedOutputW > 0 ? genOutputW / ratedOutputW : 0;
        const fuelBurnLhr   = genRunning ? this.GEN_FUEL_L_HR * genFraction : 0;
        fuel.current        = Math.max(0, fuel.current - fuelBurnLhr * dt / 3600);
        fuel.level          = (fuel.current / fuel.capacity) * 100;
        fuel.consumeRateLhr = fuelBurnLhr;
    }

    _updateStatuses() {
        const o2  = this.game.systems.o2;
        const co2 = this.game.systems.co2;

        // O2 atmospheric % — healthy range 19.5–23.5 %
        if (o2.pct < 16 || o2.pct > 25) {
            o2.status = 'Critical';
        } else if (o2.pct < 19.5 || o2.pct > 23.5) {
            o2.status = 'Warning';
        } else {
            o2.status = 'Normal';
        }

        // CO2 ppm — dangerous above 5,000 ppm
        const co2Ppm = co2.pct * 10000;
        if (co2Ppm > 5000) {
            co2.status = 'Critical';
        } else if (co2Ppm > 1000) {
            co2.status = 'Warning';
        } else {
            co2.status = 'Normal';
        }

        const power = this.game.systems.power;
        if (power.level <= 10) {
            power.status = 'Critical';
        } else if (power.level <= 30) {
            power.status = 'Warning';
        } else {
            power.status = 'Normal';
        }

        const fuel = this.game.systems.fuel;
        if (fuel.current <= 10) {
            fuel.status = 'Critical';
        } else if (fuel.current <= 30) {
            fuel.status = 'Warning';
        } else {
            fuel.status = 'Normal';
        }

        // A destroyed module is offline regardless of any other reading.
        [o2, co2, power].forEach(sys => {
            if (sys.destroyed) {
                sys.status = 'Critical';
                sys.active = false;
            }
        });
    }

    _isGameOver() {
        return this.game.systems.o2.pct <= 0 ||
               this.game.systems.co2.pct * 10000 >= 10000;
    }
}
