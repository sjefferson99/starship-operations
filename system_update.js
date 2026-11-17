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
        this.TRANSCEIVER_DRAW_W      = 4;
        this.TRANSCEIVER_TRANSMIT_W  = 2;
        this.TRANSCEIVER_RANGE_LY_PER_W = 1;
        this.WATER_MAKER_DRAW_W  = 30;
        this.WATER_MAKER_L_HR    = 6;
        this.WATER_MAKER_ATMOSPHERE_POWER_FACTOR = 0.4; // condensing from air vs reclaiming waste

        // Water usage, per crew member per day.
        this.WATER_CONSERVATIVE_L_PER_CREW_DAY = 25;
        this.WATER_NORMAL_L_PER_CREW_DAY       = 100;

        // Coming off rationing rehydrates the crew with one lump draw, rather
        // than gradually — see main.js's toggleWaterRationing().
        this.WATER_RATION_RESET_L_PER_CREW = 50;

        // Food: what's eaten ends up in the black water tank as solid waste
        // (litres per ration eaten). Rations themselves live in storage boxes
        // (fabrication.js). Status bands are days of food left at the current
        // rate of eating.
        this.SOLID_WASTE_L_PER_RATION = 1.5;
        this.FOOD_WARNING_DAYS        = 3;
        this.FOOD_CRITICAL_DAYS       = 1;

        // The black water tank counts as "full" (waste backing up into the
        // cabin — see CrewManager's sewage exposure) from this level up.
        this.BLACK_WATER_FULL_PCT = 99.9;
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
        this._computePowerBudget(dt);
        this._updateO2(dt);
        this._updateCO2(dt);
        this._updateTransceiver();
        this._updateFood(dt);
        this._updateWater(dt);
        this._updatePowerAndFuel(dt);
        this.game.crewManager.update(dt);
        this.game.crew = this.game.crewManager.aliveCount();
        this.game.repairManager.decay(dt);
        this.game.repairManager.processQueue(dt);
        this.game.fabrication.update(dt);
        this._updateStatuses();

        if (this._isGameOver()) {
            this.game.endGame();
        }
    }

    // ── Power budget ────────────────────────────────────────────────────────
    // Nothing electrical runs without power. Before any device updates, work
    // out what fraction of this tick's total electrical demand can actually be
    // met from the battery plus whatever the generator can make this tick.
    // 1 = fully powered, 0 = dead ship, in between = brownout (every device's
    // output is scaled down by the same fraction). Computed against each
    // device's full rated draw, and over the whole tick's energy rather than
    // an instantaneous "battery > 0" check, so one huge high-speed tick can't
    // run devices for 1000 seconds on a battery that only had 10 seconds left.
    _poweredDevices() {
        const s = this.game.systems;
        return [
            { sys: s.o2,          type: 'o2Generator', fallbackW: this.O2_DRAW_W_BY_TIER[s.o2.tier - 1] ?? 0 },
            { sys: s.co2,         type: 'co2Scrubber', fallbackW: this.CO2_DRAW_W_BY_TIER[s.co2.tier - 1] ?? 0 },
            { sys: s.transceiver, type: 'transceiver', fallbackW: this.TRANSCEIVER_DRAW_W },
            { sys: s.waterMaker,  type: 'waterMaker',  fallbackW: this.WATER_MAKER_DRAW_W },
        ].filter(d => d.sys);
    }

    _ratedDrawW(device) {
        return this._moduleField(device.type, device.sys.tier, 'powerDrawW', device.fallbackW) * (device.sys.count ?? 1);
    }

    _isRunning(sys) {
        return !!sys && sys.active && !sys.destroyed && sys.installed !== false;
    }

    _generatorMaxW() {
        const power = this.game.systems.power;
        const fuel  = this.game.systems.fuel;
        if (!power.active || power.destroyed || fuel.current <= 0) return 0;
        const ratedOutputW = this._moduleField('generator', power.tier, 'outputW', this.GEN_OUTPUT_W);
        return ratedOutputW * this.game.repairManager.efficiencyFor('power');
    }

    _computePowerBudget(dt) {
        const power = this.game.systems.power;
        const hours = dt / 3600;

        const demandW = this._poweredDevices()
            .filter(d => this._isRunning(d.sys))
            .reduce((sum, d) => sum + this._ratedDrawW(d), 0);

        const supplyWh = power.current + this._generatorMaxW() * hours;
        const needWh   = demandW * hours;

        power.demandW       = demandW;
        power.powerFraction = needWh > 0 ? Math.max(0, Math.min(1, supplyWh / needWh)) : (supplyWh > 0 ? 1 : 0);
    }

    _powerFraction() {
        return this.game.systems.power.powerFraction ?? 1;
    }

    _updateO2(dt) {
        const sys  = this.game.systems.o2;
        const crew = this.game.crew;

        const consumptionLhr = this.O2_CONSUMPTION_L_HR * crew;
        const ratedLhr       = this._moduleField('o2Generator', sys.tier, 'outputLhr', this.O2_GEN_L_HR_BY_TIER[sys.tier - 1] ?? 0);
        const efficiency     = this.game.repairManager.efficiencyFor('o2');
        const maxGenLhr      = ratedLhr * sys.count * efficiency * this._powerFraction();

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
        const efficiency    = this.game.repairManager.efficiencyFor('co2');
        const maxScrLhr     = ratedLhr * sys.count * efficiency * this._powerFraction();

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

    // Transceiver: effective transmit power falls with the same repair
    // efficiency curve as every other module, and range is simply proportional
    // to it. What that range actually reveals is CommsNav's business.
    _updateTransceiver() {
        const sys = this.game.systems.transceiver;
        if (!sys) return;

        const ratedTransmitW = this._moduleField('transceiver', sys.tier, 'transmitW', this.TRANSCEIVER_TRANSMIT_W);
        const rangeLyPerW    = this._moduleField('transceiver', sys.tier, 'rangeLyPerW', this.TRANSCEIVER_RANGE_LY_PER_W);
        const efficiency     = this.game.repairManager.efficiencyFor('transceiver');
        const running        = this._isRunning(sys);
        const fraction       = running ? this._powerFraction() : 0;

        sys.ratedTransmitW = ratedTransmitW;
        sys.ratedRangeLy   = ratedTransmitW * rangeLyPerW;
        sys.transmitW      = ratedTransmitW * efficiency * fraction;
        sys.rangeLy        = sys.transmitW * rangeLyPerW;
        sys.loadFraction   = running ? 1 : 0; // no throttling — draws its full (small) rating whenever on
    }

    _updatePowerAndFuel(dt) {
        const power = this.game.systems.power;
        const fuel  = this.game.systems.fuel;
        const s     = this.game.systems;
        const fraction = this._powerFraction();

        // Each device draws in proportion to how hard it's actually working
        // (its throttle fraction) and to how much power it's actually getting.
        const loadOf = { o2Generator: s.o2.genFraction ?? 1, co2Scrubber: s.co2.scrFraction ?? 1,
                         transceiver: s.transceiver?.loadFraction ?? 0, waterMaker: s.waterMaker?.loadFraction ?? 0 };
        let totalDrawW = 0;
        this._poweredDevices().forEach(d => {
            d.sys.drawW = this._isRunning(d.sys) ? this._ratedDrawW(d) * loadOf[d.type] * fraction : 0;
            totalDrawW += d.sys.drawW;
        });

        // Proportional generator: at/above battery target throttle to cover exact draw
        // so net battery = 0 and display reads "Stable" rather than flickering.
        const ratedOutputW = this._moduleField('generator', power.tier, 'outputW', this.GEN_OUTPUT_W);
        const maxOutputW   = this._generatorMaxW();
        const genRunning   = power.active && !power.destroyed && fuel.current > 0;
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
        power.o2DrawW    = s.o2.drawW;
        power.co2DrawW   = s.co2.drawW;
        power.otherDrawW = (s.transceiver?.drawW ?? 0) + (s.waterMaker?.drawW ?? 0);
        power.netWhr     = netW;

        // Fuel burn proportional to nominal (undamaged) rated output — a degraded
        // generator burns the same fuel per watt it can still produce.
        const genFraction   = ratedOutputW > 0 ? genOutputW / ratedOutputW : 0;
        const fuelBurnLhr   = genRunning ? this.GEN_FUEL_L_HR * genFraction : 0;
        fuel.current        = Math.max(0, fuel.current - fuelBurnLhr * dt / 3600);
        fuel.level          = (fuel.current / fuel.capacity) * 100;
        fuel.consumeRateLhr = fuelBurnLhr;
    }

    // The crew eat from the food boxes. Running out starts the starvation
    // clock (CrewManager's hunger effects); any food at all stops it. What was
    // eaten becomes this tick's solid waste, which _updateWater puts in the
    // black water tank. Eating is clamped to what's aboard, so one huge tick
    // can't eat food that isn't there.
    _updateFood(dt) {
        const food  = this.game.systems.food;
        const fab   = this.game.fabrication;
        const hours = dt / 3600;
        const crew  = this.game.crew;

        const perDay = fab.RATIONS_PER_CREW_DAY * crew;
        const wanted = perDay * hours / 24;
        const eaten  = fab.eat(wanted);

        food.eatRatePerDay = perDay;
        food.rations       = fab.rationsAboard();
        food.daysLeft      = perDay > 0 ? food.rations / perDay : Infinity;
        // Hungry for the part of the tick there was nothing left to eat.
        const unfedHours   = wanted > 0 ? hours * (1 - eaten / wanted) : 0;
        food.starvedHours  = unfedHours > 1e-9 ? (food.starvedHours || 0) + unfedHours : 0;
        this._solidWasteL  = eaten * this.SOLID_WASTE_L_PER_RATION;
        food.solidRateLhr  = perDay / 24 * this.SOLID_WASTE_L_PER_RATION;
    }

    _updateWater(dt) {
        const fresh = this.game.systems.freshWater;
        const black = this.game.systems.blackWater;
        const hours = dt / 3600;
        const crew  = this.game.crew;

        const dailyRateLPerCrew = fresh.rationing
            ? this.WATER_CONSERVATIVE_L_PER_CREW_DAY
            : this.WATER_NORMAL_L_PER_CREW_DAY;
        const consumeLhr = (dailyRateLPerCrew * crew) / 24;
        const consumed    = Math.min(fresh.current, consumeLhr * hours);

        fresh.current        = Math.max(0, fresh.current - consumed);
        fresh.consumeRateLhr = consumeLhr;

        // 90% of the fresh water actually drawn becomes black-water liquid (10%
        // lost to drinking/showering/evaporation). Solid waste comes from the
        // food eaten this tick (_updateFood), tracked separately for the
        // dashboard split and because the water maker can only reclaim liquid.
        const liquidProduced = consumed * 0.9;
        const solidProduced  = this._solidWasteL || 0;
        this._solidWasteL    = 0;
        const totalProduced  = liquidProduced + solidProduced;
        const capacityLeft   = Math.max(0, black.capacity - (black.liquidL + black.solidL));
        const overflowRatio  = totalProduced > 0 ? Math.min(1, capacityLeft / totalProduced) : 1;

        black.liquidL = black.liquidL + liquidProduced * overflowRatio;
        black.solidL  = black.solidL  + solidProduced  * overflowRatio;

        this._runWaterMaker(hours);

        fresh.level          = (fresh.current / fresh.capacity) * 100;
        fresh.depletedHours  = fresh.current <= 0 ? (fresh.depletedHours || 0) + hours : 0;
        fresh.rationHours    = fresh.rationing ? (fresh.rationHours || 0) + hours : 0;

        black.current = black.liquidL + black.solidL;
        black.level   = (black.current / black.capacity) * 100;

        // A full tank has nowhere to put new waste — it backs up into the cabin.
        // Exposure time drives CrewManager's sewage health effects and resets
        // the moment the tank is relieved (dumped, or reclaimed by a water maker).
        black.exposureHours = black.level >= this.BLACK_WATER_FULL_PCT ? (black.exposureHours || 0) + hours : 0;

        // Net of what the water maker took back out this tick, so the dashboard's
        // fill rate goes negative when reclamation is winning.
        black.liquidRateLhr = fresh.consumeRateLhr * 0.9;
        black.solidRateLhr  = this.game.systems.food?.solidRateLhr ?? 0;
        black.fillRateLhr   = black.liquidRateLhr + black.solidRateLhr - (black.reclaimRateLhr || 0);
    }

    // Water maker: reclaims black-water liquid into fresh water first; while
    // parked in a breathable atmosphere it makes up any shortfall by condensing
    // moisture from outside air. In space, black-water liquid is its only source.
    _runWaterMaker(hours) {
        const wm    = this.game.systems.waterMaker;
        const fresh = this.game.systems.freshWater;
        const black = this.game.systems.blackWater;
        if (!wm) return;

        wm.outputLhr = 0; wm.loadFraction = 0; wm.source = 'none';
        black.reclaimRateLhr = 0;
        black.reclaimStarved = false; // true when the maker wanted more than the tank's liquid could give
        wm.ratedLhr  = this._moduleField('waterMaker', wm.tier, 'outputLhr', this.WATER_MAKER_L_HR) * (wm.count ?? 1);
        if (!this._isRunning(wm) || hours <= 0) return;

        const efficiency = this.game.repairManager.efficiencyFor('waterMaker');
        const maxL = wm.ratedLhr * efficiency * this._powerFraction() * hours;
        if (maxL <= 0) return;

        const roomL     = Math.max(0, fresh.capacity - fresh.current);
        const wantL     = Math.min(maxL, roomL);
        const fromBlack = Math.min(wantL, black.liquidL);
        const fromAir   = this.game.inBreathableAtmosphere ? wantL - fromBlack : 0;
        const madeL     = fromBlack + fromAir;

        black.liquidL  -= fromBlack;
        fresh.current  += madeL;

        // Only the liquid can be reclaimed. If the maker had capacity to spare but
        // the liquid ran out, what's left in the tank is solid matter it can't touch.
        black.reclaimRateLhr = fromBlack / hours;
        black.reclaimStarved = fromBlack < wantL;

        // Condensing clean moisture from outside air is far less work than
        // processing waste, so that share of the output draws less power
        // (`atmospherePowerFactor` in module_specs.json).
        const airFactor = this._moduleField('waterMaker', wm.tier, 'atmospherePowerFactor', this.WATER_MAKER_ATMOSPHERE_POWER_FACTOR);
        wm.outputLhr    = madeL / hours;
        wm.loadFraction = (fromBlack + fromAir * airFactor) / maxL;
        wm.source       = madeL <= 0 ? (roomL <= 0 ? 'full' : 'none') : fromAir > fromBlack ? 'atmosphere' : 'blackWater';
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

        const freshWater = this.game.systems.freshWater;
        if (freshWater.level <= 10) {
            freshWater.status = 'Critical';
        } else if (freshWater.level <= 30) {
            freshWater.status = 'Warning';
        } else {
            freshWater.status = 'Normal';
        }

        const blackWater = this.game.systems.blackWater;
        if (blackWater.level >= 90) {
            blackWater.status = 'Critical';
        } else if (blackWater.level >= 70) {
            blackWater.status = 'Warning';
        } else {
            blackWater.status = 'Normal';
        }

        // Food: by days left at the current rate of eating.
        const food = this.game.systems.food;
        if (food) {
            const days = food.daysLeft ?? Infinity;
            food.status = (food.rations ?? 0) <= 0 || days < this.FOOD_CRITICAL_DAYS ? 'Critical'
                        : days < this.FOOD_WARNING_DAYS ? 'Warning' : 'Normal';
        }

        // Transceiver: fine once it can reach the local network, otherwise a warning.
        const transceiver = this.game.systems.transceiver;
        if (transceiver) {
            transceiver.status = this.game.commsNav.hasLocalDetails() ? 'Normal' : 'Warning';
        }

        const waterMaker = this.game.systems.waterMaker;
        if (waterMaker) {
            waterMaker.status = (waterMaker.installed && (waterMaker.repairPct ?? 100) < 50) ? 'Warning' : 'Normal';
        }

        // A destroyed module is offline regardless of any other reading.
        [o2, co2, power, transceiver, waterMaker].forEach(sys => {
            if (sys && sys.destroyed) {
                sys.status = 'Critical';
                sys.active = false;
            }
        });
    }

    // Game over is crew death only — bad atmosphere/power/fuel readings damage
    // crew health (CrewManager) rather than ending the game directly.
    _isGameOver() {
        const roster = this.game.crewManifest || [];
        return roster.length > 0 && this.game.crewManager.aliveCount() === 0;
    }
}
