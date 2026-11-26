// Logistics: where the ship is berthed, the transfer drones that fetch and
// carry for it, the goods waiting for them at the port, stripping the wrecked
// drives for parts, and the short hop across the planet on atmospheric
// thrusters.
//
// The ship starts in Harlow's Salvage yard, out past the edge of Port Carrow,
// with both drives wrecked. Everything bought or sold changes hands at the
// port, so until she can fly there herself, goods travel by drone: a purchase
// waits in the port hold (`game.portHold`) until a drone run collects it, and
// something sold goes out on a drone and is paid for when it lands at the port.
// Once the ship is berthed at the port, trade is direct and the hold empties
// straight aboard.
//
// State (all saved — see GameState / db.js):
//   game.berth      'yard' | 'port'      where she's set down (or flying from)
//   game.flight     { to, hoursLeft, totalHours, fuelL } while in the air, else
//                   null. fuelL is the hop's whole fuel bill, burnt evenly over
//                   the flight (worked out from the ship's mass at lift-off)
//   game.droneDocks number of drone docks fitted
//   game.drones     [{ id, tier, repairPct, juryRigged, destroyed, chargeWh,
//                      chargeFromBattery, plan, planOut, state, hoursLeft, cargoOut, cargoIn, base }]
//                   base: the berth ('yard' | 'port') a drone outside the ship flies
//                   back to — where the ship was when it left. The ship may have
//                   flown on meanwhile: the drone lands there anyway and waits,
//                   and the ship has to go back for it. Aboard, it goes where she does.
//                   planOut: [{ kind: 'module' | 'compost', boxId }] — what the next
//                   run takes to the port to sell, loaded out of its box at launch
//                   state: 'arriving' (bought, flying itself over) | 'outbound'
//                   | 'returning' | 'parked' (outside, not charging) | 'stowed'
//                   (aboard, not charging) | 'docked' (aboard, charging)
//   game.portHold   [{ id, kind: 'item' | 'food' | 'fuel' | 'module', ... }]
//
// A drone is a unit RepairManager can repair: unit key 'drone:<id>', spec
// 'transferDrone' in module_specs.json. It wears and spends charge per km.

class Logistics {
    static _seq = 0;

    constructor(game) {
        this.game = game;

        this.PLANET_NAME = 'Kel Veth III';
        this.YARD_NAME   = 'Harlow\'s Salvage';
        this.PORT_NAME   = 'Port Carrow';
        this.YARD_TO_PORT_KM = 120;

        this.DRONE_NAME  = 'Transfer Drone';
        this.DRONE_PRICE = 300;
        this.MIN_LAUNCH_PCT = 20; // a drone below this condition won't fly

        // Fuel is sold in lots at the port; 1 kg a litre, so a drone carries 35 L.
        this.FUEL = { name: 'Fuel', lotL: 5, pricePerL: 12, kgPerL: 1 };

        // What comes off a wrecked drive, and how long the crew take to strip it.
        this.DRIVE_NAMES = { thrusters: 'Atmospheric Thrusters', ionDrive: 'Ion Drive' };
        this.STRIP = {
            thrusters: { hours: 8,  yields: { precisionComponents: 2, basicComponents: 3 } },
            ionDrive:  { hours: 12, yields: { precisionComponents: 3, basicComponents: 4 } },
        };
    }

    // Fresh state for a new game.
    reset() {
        this.game.berth      = 'yard';
        this.game.flight     = null;
        this.game.droneDocks = 0;
        this.game.drones     = [];
        this.game.portHold   = [];
    }

    // ── Specs ───────────────────────────────────────────────────────────────

    _spec(type, field, fallback) {
        return this.game._moduleField(type, 1, field, fallback);
    }
    droneSpec(field) {
        const fallback = { massKg: 22, volumeM3: 0.3, payloadKg: 35, speedKmh: 100, batteryWh: 1500, whPerKm: 5, wearPctPerKm: 0.02, juryRigWearMultiplier: 10 }[field];
        return this._spec('transferDrone', field, fallback);
    }
    dockSpec(field) {
        return this._spec('droneDock', field, { massKg: 15, volumeM3: 0.15, chargeW: 120 }[field]);
    }
    hopHours()     { return this.YARD_TO_PORT_KM / this._spec('thrusters', 'cruiseKmh', 400); }
    droneLegHours(){ return this.YARD_TO_PORT_KM / this.droneSpec('speedKmh'); }

    // Fuel for a hop scales with the distance and with what she weighs:
    // fuelPerHopL is the yard → port hop at her maximum laden mass, and it
    // falls in proportion as she gets lighter (an empty hull uses
    // unladen / max of it). `km` defaults to the yard → port hop.
    hopFuelL(km = this.YARD_TO_PORT_KM) {
        const cap = this.game._computeShipCapacity();
        const massFactor = cap.maxMassKg > 0 ? cap.totalMassKg / cap.maxMassKg : 1;
        const fuelL = this._spec('thrusters', 'fuelPerHopL', 20) * massFactor * (km / this.YARD_TO_PORT_KM);
        return Math.round(fuelL * 10) / 10;
    }

    // A drone's energy per km follows what it's lifting: whPerKm is the drone
    // fully loaded (its own mass plus payloadKg), falling in proportion to its
    // all-up mass, down to just its own mass when it flies empty.
    droneWhPerKm(cargoKg = 0) {
        const own = this.droneSpec('massKg'), full = own + this.droneSpec('payloadKg');
        return this.droneSpec('whPerKm') * (own + Math.max(0, cargoKg)) / full;
    }

    droneLegWh(cargoKg = 0) {
        return this.YARD_TO_PORT_KM * this.droneWhPerKm(cargoKg);
    }

    // Energy for a run to the port and back: out with what it takes to sell,
    // back with what's on its plan. With no drone, the worst case (full both ways).
    // `outKg` overrides the outbound load (a sale sent from the market).
    roundTripWh(drone = null, { outKg } = {}) {
        const payload = this.droneSpec('payloadKg');
        if (!drone) return 2 * this.droneLegWh(payload);
        const out = outKg ?? this.planOutMassKg(drone);
        return this.droneLegWh(out) + this.droneLegWh(this.planMassKg(drone));
    }

    // ── Where the ship is ───────────────────────────────────────────────────

    berth()     { return this.game.berth ?? 'yard'; }
    isFlying()  { return !!this.game.flight; }
    atPort()    { return !this.isFlying() && this.berth() === 'port'; }
    berthName(berth = this.berth()) { return berth === 'port' ? this.PORT_NAME : this.YARD_NAME; }

    // What the header shows as the ship's location.
    locationLabel() {
        if (this.isFlying()) return `In flight to ${this.berthName(this.game.flight.to)}`;
        return `${this.berthName()}, ${this.PLANET_NAME}`;
    }

    // How trade works right now: 'direct' at the port, 'drone' from the yard,
    // or null (in the air, or the local network out of range).
    tradeMode() {
        if (this.isFlying() || !this.game.commsNav.hasLocalDetails()) return null;
        return this.atPort() ? 'direct' : 'drone';
    }

    tradeBlocker() {
        if (this.isFlying()) return 'In flight — wait until she\'s down';
        if (!this.game.commsNav.hasLocalDetails()) return 'Local network out of range';
        return null;
    }

    // ── Drones ──────────────────────────────────────────────────────────────

    drones()     { return this.game.drones ?? (this.game.drones = []); }
    drone(id)    { return this.drones().find(d => d.id === id) ?? null; }
    droneLabel(drone) { return `${this.DRONE_NAME} ${this.drones().indexOf(drone) + 1}`; }
    unitKey(drone)    { return `drone:${drone.id}`; }
    isHome(drone)     { return ['parked', 'stowed', 'docked'].includes(drone.state); }
    isAboard(drone)   { return drone.state === 'stowed' || drone.state === 'docked'; }
    isAway(drone)     { return !this.isHome(drone); }
    // Where a drone is (or is flying back to): aboard, wherever the ship is.
    droneBase(drone)  { return this.isAboard(drone) ? this.berth() : (drone.base ?? this.berth()); }
    // Home and somewhere the crew can reach it: aboard, or parked beside her.
    isWithShip(drone) {
        if (this.isAboard(drone)) return true;
        return drone.state === 'parked' && !this.isFlying() && this.droneBase(drone) === this.berth();
    }
    // Landed where the ship was, but she's gone on: it waits for her to come back.
    isLeftBehind(drone) { return drone.state === 'parked' && !this.isWithShip(drone); }
    _leftBehindNote(drone) {
        return this.isFlying() ? 'The ship is in the air' : `Waiting at ${this.berthName(this.droneBase(drone))} — fly there to pick it up`;
    }
    droneKeys()       { return this.drones().map(d => this.unitKey(d)); }
    freeDocks()       { return Math.max(0, (this.game.droneDocks ?? 0) - this.drones().filter(d => d.state === 'docked').length); }

    _newId(prefix) {
        return `${prefix}-${Date.now().toString(36)}-${++Logistics._seq}`;
    }

    entryMassKg(entry) {
        const fab = this.game.fabrication;
        switch (entry.kind) {
            case 'item':    return (fab.ITEMS[entry.key]?.massKg ?? 0) * entry.count;
            case 'food':    return entry.rations * fab.FOOD.massKgPerRation;
            case 'fuel':    return entry.litres * this.FUEL.kgPerL;
            case 'module':  return fab.moduleMassKg(entry);
            case 'compost': return entry.litres * fab.BOX.contentDensityKgPerL;
            default:        return 0;
        }
    }

    entryLabel(entry) {
        const fab = this.game.fabrication;
        switch (entry.kind) {
            case 'item':    return `${entry.count} × ${fab.ITEMS[entry.key]?.name ?? entry.key}`;
            case 'food':    return `${entry.rations} ${fab.FOOD.name.toLowerCase()}`;
            case 'fuel':    return `${entry.litres} L fuel`;
            case 'module':  return `${fab.moduleName(entry.moduleKey)} (${Math.round(entry.repairPct ?? 100)}%)`;
            case 'compost': return `${entry.litres.toFixed(1)} L compost`;
            default:        return entry.kind;
        }
    }

    cargoMassKg(list) {
        return (list ?? []).reduce((sum, e) => sum + this.entryMassKg(e), 0);
    }

    holdMassKg() {
        return this.cargoMassKg(this.game.portHold);
    }

    // Buying a drone: it flies itself over from the port, charged and in good order.
    buyDroneBlocker() {
        const blocked = this.tradeBlocker();
        if (blocked) return blocked;
        if (this.game.credits < this.DRONE_PRICE) return 'Not enough credits';
        return null;
    }

    buyDrone() {
        if (this.buyDroneBlocker()) return null;
        this.game.credits -= this.DRONE_PRICE;
        const drone = {
            id: this._newId('drone'), tier: 1, repairPct: 100, juryRigged: false, destroyed: false,
            chargeWh: this.droneSpec('batteryWh'), chargeFromBattery: false, plan: [], planOut: [], state: 'arriving',
            hoursLeft: this.atPort() ? 0 : this.droneLegHours(), cargoOut: [], cargoIn: [], base: this.berth(),
        };
        this.drones().push(drone);
        if (drone.hoursLeft <= 0) this._settleHome(drone);
        return drone;
    }

    // Where a drone goes on getting back: a free dock, else aboard if there's
    // room, else set down outside.
    // If the ship has flown on since it left, it lands where she was and waits.
    _settleHome(drone) {
        drone.hoursLeft = 0;
        if (this.isFlying() || this.droneBase(drone) !== this.berth()) { drone.state = 'parked'; return; }
        if (this.freeDocks() > 0) { drone.state = 'docked'; return; }
        drone.state = 'parked'; // not counted while we ask whether it fits
        drone.state = this._droneSpaceBlocker(drone) ? 'parked' : 'stowed';
    }

    _droneMassKg(drone) {
        return this.droneSpec('massKg') + this.cargoMassKg(drone.cargoIn);
    }

    // Would bringing this (currently outside) drone aboard fit?
    _droneSpaceBlocker(drone) {
        return this.game.fabrication.spaceBlocker(this._droneMassKg(drone), this.droneSpec('volumeM3'));
    }

    dockBlocker(drone) {
        if (!drone || !this.isHome(drone)) return 'Out on a run';
        if (drone.state === 'docked') return 'Already docked';
        if (this.isLeftBehind(drone)) return this._leftBehindNote(drone);
        if (this.freeDocks() < 1) return (this.game.droneDocks ?? 0) ? 'Every dock is in use' : 'No drone dock — fabricate one in the Work Queue';
        if (drone.state === 'parked') return this._droneSpaceBlocker(drone);
        return null;
    }

    stowBlocker(drone) {
        if (!drone || !this.isHome(drone)) return 'Out on a run';
        if (drone.state === 'stowed') return 'Already stowed';
        if (this.isLeftBehind(drone)) return this._leftBehindNote(drone);
        if (drone.state === 'parked') return this._droneSpaceBlocker(drone);
        return null;
    }

    parkBlocker(drone) {
        if (!drone || !this.isHome(drone)) return 'Out on a run';
        if (drone.state === 'parked') return 'Already outside';
        if (this.isFlying()) return 'In flight';
        return null;
    }

    setDroneBerth(droneId, state) {
        const drone = this.drone(droneId);
        const blocker = { docked: this.dockBlocker, stowed: this.stowBlocker, parked: this.parkBlocker }[state]?.call(this, drone);
        if (!drone || blocker !== null) return false;
        drone.state = state;
        return true;
    }

    // Why this drone can't be sent on a run right now, or null. A run needs a
    // reason: something planned to bring back, or (`forSale`) something to sell.
    // `outKg` is the load a sale would send out (see roundTripWh).
    launchBlocker(drone, { forSale = false, outKg } = {}) {
        if (!drone) return 'No drone';
        if (!this.isHome(drone)) return drone.state === 'arriving' ? 'On its way to you' : 'Out on a run';
        if (this.isFlying()) return 'In flight';
        if (this.isLeftBehind(drone)) return this._leftBehindNote(drone);
        if (this.atPort()) return 'You\'re at the port — trade directly';
        if (!this.game.commsNav.hasLocalDetails()) return 'Drones fly on the local network — it\'s out of range';
        if (this.game.repairQueue.some(t => t.systemKey === this.unitKey(drone))) return 'Being repaired';
        if ((drone.repairPct ?? 100) < this.MIN_LAUNCH_PCT) return `Below ${this.MIN_LAUNCH_PCT}% condition — repair it first`;
        const need = this.roundTripWh(drone, { outKg: forSale ? (outKg ?? this.droneSpec('payloadKg')) : undefined });
        if ((drone.chargeWh ?? 0) < need - 1e-6) {
            return `Needs ${Math.round(need)} Wh for the round trip (has ${Math.round(drone.chargeWh ?? 0)}) — dock it to charge`;
        }
        if (!forSale && !this.plan(drone).length && !this.planOut(drone).length) {
            return 'Nothing planned to bring back or send — use Plan Run first';
        }
        return null;
    }

    // The first drone that could go right now with something to sell (it also
    // brings back whatever is on its plan).
    readyDrone(outKg) {
        return this.drones().find(d => !this.launchBlocker(d, { forSale: true, outKg })) ?? null;
    }

    // Sends a drone to the port and back. `cargoOut` is what it carries to
    // sell; it brings back what's on its plan.
    launch(droneId, cargoOut = []) {
        const drone = this.drone(droneId);
        if (this.launchBlocker(drone, { forSale: cargoOut.length > 0, outKg: this.cargoMassKg(cargoOut) })) return false;
        if (!cargoOut.length) cargoOut = this._loadOut(drone);
        drone.base      = this.berth(); // where it comes back to
        drone.planOut   = [];
        drone.state     = 'outbound';
        drone.hoursLeft = this.droneLegHours();
        drone.cargoOut  = cargoOut;
        return true;
    }

    // ── Outbound plan: what a run takes to the port to sell ─────────────────

    planOut(drone) {
        return drone?.planOut ?? [];
    }

    // What aboard could go to the port to sell: stored modules and finished compost.
    outCandidates() {
        const fab = this.game.fabrication;
        const out = [];
        fab.machineBoxes().forEach(b => { if (b.module) out.push({ kind: 'module', boxId: b.id }); });
        fab.boxes().forEach(b => { if (!fab.isMachineBox(b) && fab.boxStatus(b) === 'ready') out.push({ kind: 'compost', boxId: b.id }); });
        return out;
    }

    // Which drone's outbound plan has this box on it, if any.
    outPlannedBy(boxId) {
        return this.drones().find(d => this.planOut(d).some(o => o.boxId === boxId)) ?? null;
    }

    _outValid(item) {
        const fab = this.game.fabrication;
        const box = fab._box(item.boxId);
        if (!box) return false;
        return item.kind === 'module' ? !!box.module : fab.boxStatus(box) === 'ready';
    }

    // Outbound mass: modules whole, then compost fills what's left of the payload.
    planOutMassKg(drone) {
        const fab = this.game.fabrication;
        let modules = 0, compost = 0;
        this.planOut(drone).forEach(o => {
            const box = fab._box(o.boxId);
            if (!box) return;
            if (o.kind === 'module' && box.module) modules += fab.moduleMassKg(box.module);
            if (o.kind === 'compost') compost += box.fillL * fab.BOX.contentDensityKgPerL;
        });
        return modules + Math.min(compost, Math.max(0, this.droneSpec('payloadKg') - modules));
    }

    // Litres of compost from each box on this drone's outbound plan that will
    // actually go — modules first, then compost in plan order up to the payload
    // (as _loadOut takes it). { boxId: litres }
    planOutCompostLitres(drone) {
        const fab = this.game.fabrication;
        let room = this.droneSpec('payloadKg');
        const out = {};
        this.planOut(drone).forEach(o => {
            const box = fab._box(o.boxId);
            if (o.kind === 'module' && box?.module) room -= fab.moduleMassKg(box.module);
        });
        this.planOut(drone).forEach(o => {
            const box = fab._box(o.boxId);
            if (o.kind !== 'compost' || !box) return;
            const litres = Math.max(0, Math.min(box.fillL, room / fab.BOX.contentDensityKgPerL));
            out[o.boxId] = litres;
            room -= litres * fab.BOX.contentDensityKgPerL;
        });
        return out;
    }

    // How much of a compost box one drone run can take on its own.
    compostLitresPerRun(box) {
        return Math.min(box?.fillL ?? 0, this.droneSpec('payloadKg') / this.game.fabrication.BOX.contentDensityKgPerL);
    }

    planOutAddBlocker(drone, boxId) {
        if (!drone) return 'No drone';
        if (!this.isHome(drone)) return 'Out on a run — plan its next one when it\'s back';
        const item = this.outCandidates().find(o => o.boxId === boxId);
        if (!item) return 'Nothing to send from that box';
        if (this.outPlannedBy(boxId)) return 'Already planned to go';
        if (this.game.fabrication.breakDownTask(`box:${boxId}`)) return 'Being broken down in the Work Queue';
        const fab  = this.game.fabrication;
        const room = this.droneSpec('payloadKg') - this.planOutMassKg(drone);
        if (item.kind === 'module') {
            const mass = fab.moduleMassKg(fab._box(boxId).module);
            if (mass > this.droneSpec('payloadKg') + 1e-9) return `Too heavy for a drone (${Math.round(mass)} kg) — sell it at the port`;
            if (mass > room + 1e-9) return `Over the drone's ${this.droneSpec('payloadKg')} kg limit`;
        } else if (room <= 1e-6) {
            return `Over the drone's ${this.droneSpec('payloadKg')} kg limit`;
        }
        return null;
    }

    planOutAdd(droneId, boxId) {
        const drone = this.drone(droneId);
        if (this.planOutAddBlocker(drone, boxId)) return false;
        const item = this.outCandidates().find(o => o.boxId === boxId);
        if (!drone.planOut) drone.planOut = [];
        drone.planOut.push({ kind: item.kind, boxId });
        return true;
    }

    planOutRemove(droneId, boxId) {
        const drone = this.drone(droneId);
        if (!drone || !this.planOut(drone).some(o => o.boxId === boxId)) return false;
        drone.planOut = drone.planOut.filter(o => o.boxId !== boxId);
        return true;
    }

    // At launch: takes what's planned out of its boxes. Modules go whole (and any
    // repair queued on them is dropped); compost goes up to what's left of the
    // payload, the rest staying in its box for another run.
    _loadOut(drone) {
        const fab = this.game.fabrication;
        const cargo = [];
        let room = this.droneSpec('payloadKg');
        const items = this.planOut(drone).filter(o => this._outValid(o));
        items.filter(o => o.kind === 'module').forEach(o => {
            const box = fab._box(o.boxId);
            cargo.push({ kind: 'module', ...box.module });
            room -= fab.moduleMassKg(box.module);
            box.module = null;
            const unit = `box:${box.id}`;
            this.game.repairQueue = this.game.repairQueue.filter(t => t.systemKey !== unit);
        });
        items.filter(o => o.kind === 'compost').forEach(o => {
            const box = fab._box(o.boxId);
            const litres = Math.min(box.fillL, Math.max(0, room) / fab.BOX.contentDensityKgPerL);
            if (litres <= 1e-6) return;
            box.fillL -= litres;
            room -= litres * fab.BOX.contentDensityKgPerL;
            if (box.fillL <= 1e-6) fab._clearBox(box);
            cargo.push({ kind: 'compost', litres });
        });
        return cargo;
    }

    // ── Buying and selling from the yard ────────────────────────────────────

    // Whether something of `massKg` bought now can reach the ship: always at the
    // port; from the yard only by drone.
    orderBlocker(massKg) {
        if (this.tradeMode() !== 'drone') return null;
        if (!this.drones().length) return 'Buy a transfer drone first — nothing reaches the yard without one';
        const payload = this.droneSpec('payloadKg');
        if (massKg > payload + 1e-9) return `Too heavy for a drone (${Math.round(massKg)} kg; one carries ${payload} kg) — collect it at the port`;
        return null;
    }

    // ── Planning a run ──────────────────────────────────────────────────────
    // Each drone keeps a plan of what to bring back on its next run:
    // drone.plan = [{ holdId, qty }] — qty is a count of supplies, rations or
    // litres of fuel, or 1 for a module. A plan never exceeds the payload or
    // what's waiting (counting other drones' plans), and the run loads exactly
    // it. Whole orders the player hasn't planned stay at the port.

    // The divisible field of an order, its unit mass, and how much there is.
    _entryUnit(entry) {
        const fab = this.game.fabrication;
        switch (entry.kind) {
            case 'item': return { field: 'count',   unitKg: fab.ITEMS[entry.key]?.massKg ?? 0 };
            case 'food': return { field: 'rations', unitKg: fab.FOOD.massKgPerRation };
            case 'fuel': return { field: 'litres',  unitKg: this.FUEL.kgPerL };
            default:     return { field: null,      unitKg: this.entryMassKg(entry) };
        }
    }

    entryQty(entry) {
        const { field } = this._entryUnit(entry);
        return field ? entry[field] : 1;
    }

    // "3 × Basic Components" for a share of an order.
    planItemLabel(entry, qty) {
        const { field } = this._entryUnit(entry);
        return this.entryLabel(field ? { ...entry, [field]: qty } : entry);
    }

    plan(drone) {
        return drone?.plan ?? [];
    }

    _holdEntry(holdId) {
        return (this.game.portHold ?? []).find(e => e.id === holdId) ?? null;
    }

    // How much of an order is in drone plans already (all drones, or all but one).
    plannedQty(holdId, exceptDrone = null) {
        return this.drones().filter(d => d !== exceptDrone)
            .reduce((sum, d) => sum + this.plan(d).filter(p => p.holdId === holdId).reduce((s, p) => s + p.qty, 0), 0);
    }

    // What of an order is still free to plan.
    availableQty(holdId) {
        const entry = this._holdEntry(holdId);
        return entry ? Math.max(0, this.entryQty(entry) - this.plannedQty(holdId)) : 0;
    }

    planMassKg(drone) {
        return this.plan(drone).reduce((sum, p) => {
            const entry = this._holdEntry(p.holdId);
            return entry ? sum + this._entryUnit(entry).unitKg * p.qty : sum;
        }, 0);
    }

    planRoomKg(drone) {
        return Math.max(0, this.droneSpec('payloadKg') - this.planMassKg(drone));
    }

    // Everything already headed aboard: every drone's plan, and what drones
    // are carrying home (or couldn't unload yet). [{ entry, qty }]
    _incoming() {
        const out = [];
        this.drones().forEach(d => {
            this.plan(d).forEach(p => {
                const entry = this._holdEntry(p.holdId);
                if (entry) out.push({ entry, qty: p.qty });
            });
            (d.cargoIn ?? []).forEach(entry => out.push({ entry, qty: this.entryQty(entry) }));
        });
        return out;
    }

    // Modules on their way that will need a machine box: stored ones, and any
    // beyond the first for a slot that's free (the first is fitted).
    _incomingBoxedModules(list) {
        const fitting = new Set();
        return list.filter(({ entry }) => {
            if (entry.kind !== 'module') return false;
            if (entry.dest === 'store') return true;
            const sys = this.game.systems[entry.moduleKey];
            const slotFree = sys && (sys.installed === false || sys.destroyed);
            if (slotFree && !fitting.has(entry.moduleKey)) { fitting.add(entry.moduleKey); return false; }
            return true;
        }).length;
    }

    // How many more units of an order there's somewhere to put aboard, after
    // everything already planned or on its way. Infinity for what needs no room.
    roomAboardFor(entry, drone = null) {
        const g = this.game, fab = g.fabrication;
        const incoming = this._incoming();
        const sum = (kind, f) => incoming.filter(i => i.entry.kind === kind).reduce((s, i) => s + f(i), 0);
        switch (entry.kind) {
            case 'item': {
                const claimedL = sum('item', i => (fab.ITEMS[i.entry.key]?.litres ?? 0) * i.qty);
                const l = fab.ITEMS[entry.key]?.litres ?? 0;
                return l > 0 ? Math.max(0, Math.floor((fab.partsRoomL() - claimedL + 1e-9) / l)) : Infinity;
            }
            case 'food':
                return Math.max(0, Math.floor(fab.foodRoom() - sum('food', i => i.qty) + 1e-9));
            case 'fuel': {
                const fuel = g.systems.fuel;
                return Math.max(0, Math.floor(fuel.capacity - fuel.current - sum('fuel', i => i.qty) + 1e-9));
            }
            case 'module': {
                const sys = g.systems[entry.moduleKey];
                const slotFree = sys && (sys.installed === false || sys.destroyed);
                const fitClaimed = incoming.some(i => i.entry.kind === 'module' && i.entry.moduleKey === entry.moduleKey && i.entry.dest !== 'store');
                if (entry.dest !== 'store' && slotFree && !fitClaimed) return 1;
                // A module this drone takes out to sell frees its box for one coming back.
                const freed = this.planOut(drone).filter(o => o.kind === 'module' && this._outValid(o)).length;
                const empty = fab.machineBoxes().filter(b => !b.module).length + freed;
                return Math.max(0, empty - this._incomingBoxedModules(incoming));
            }
            default:
                return Infinity;
        }
    }

    _noRoomReason(entry) {
        switch (entry.kind) {
            case 'item':   return 'No room left in the storage boxes for it (counting what\'s already planned or on its way)';
            case 'food':   return 'No room left for food in the storage boxes (counting what\'s already planned or on its way)';
            case 'fuel':   return 'The fuel tank can\'t take any more (counting what\'s already planned or on its way)';
            case 'module': return 'No empty machine storage box left for it (counting what\'s already planned or on its way)';
            default:       return 'No room aboard for it';
        }
    }

    // The most of an order that could still go on this drone's plan.
    planMaxFit(drone, holdId) {
        const entry = this._holdEntry(holdId);
        if (!entry) return 0;
        const { field, unitKg } = this._entryUnit(entry);
        const available = Math.min(this.availableQty(holdId), this.roomAboardFor(entry, drone));
        if (!field) return available > 0 && unitKg <= this.planRoomKg(drone) + 1e-9 ? 1 : 0;
        const byMass = unitKg > 0 ? Math.floor((this.planRoomKg(drone) + 1e-9) / unitKg) : available;
        return Math.max(0, Math.min(available, byMass));
    }

    planAddBlocker(drone, holdId, qty = 1) {
        if (!drone) return 'No drone';
        if (!this.isHome(drone)) return 'Out on a run — plan its next one when it\'s back';
        const entry = this._holdEntry(holdId);
        if (!entry) return 'No longer waiting at the port';
        if (this.availableQty(holdId) < qty) return 'Nothing more of that waiting';
        if (this._entryUnit(entry).unitKg * qty > this.planRoomKg(drone) + 1e-9) {
            return `Over the drone's ${this.droneSpec('payloadKg')} kg limit`;
        }
        if (this.roomAboardFor(entry, drone) < qty) return this._noRoomReason(entry);
        return null;
    }

    // Adds `qty` (or, with 'max', all that fits) of an order to the plan.
    planAdd(droneId, holdId, qty = 1) {
        const drone = this.drone(droneId);
        const n = qty === 'max' ? this.planMaxFit(drone, holdId) : qty;
        if (n <= 0 || this.planAddBlocker(drone, holdId, n)) return false;
        if (!drone.plan) drone.plan = [];
        const item = drone.plan.find(p => p.holdId === holdId);
        if (item) item.qty += n; else drone.plan.push({ holdId, qty: n });
        return true;
    }

    // Takes `qty` (or, with 'all', the whole line) back off the plan.
    planRemove(droneId, holdId, qty = 'all') {
        const drone = this.drone(droneId);
        const item = this.plan(drone).find(p => p.holdId === holdId);
        if (!item) return false;
        item.qty -= qty === 'all' ? item.qty : qty;
        if (item.qty <= 0) drone.plan = drone.plan.filter(p => p !== item);
        return true;
    }

    planClear(droneId) {
        const drone = this.drone(droneId);
        if (!drone) return false;
        drone.plan = [];
        drone.planOut = [];
        return true;
    }

    // Plans follow the hold: an order that's gone (collected at the port)
    // drops out, and one that shrank caps what's planned from it.
    _tidyPlans() {
        this.drones().forEach(d => {
            if (d.planOut?.length) d.planOut = d.planOut.filter(o => this._outValid(o));
            if (!d.plan?.length) return;
            d.plan = d.plan.filter(p => this._holdEntry(p.holdId) && p.qty > 0);
            d.plan.forEach(p => {
                const over = this.plannedQty(p.holdId) - this.entryQty(this._holdEntry(p.holdId));
                if (over > 0) p.qty = Math.max(0, p.qty - over);
            });
            d.plan = d.plan.filter(p => p.qty > 0);
        });
    }

    // Fuel, a lot at a time: into the tank at the port, by drone from the yard.
    fuelLotPrice() {
        return this.FUEL.lotL * this.FUEL.pricePerL;
    }

    buyFuelBlocker() {
        const mode = this.tradeMode();
        if (!mode) return this.tradeBlocker();
        if (this.game.credits < this.fuelLotPrice()) return 'Not enough credits';
        const massKg = this.FUEL.lotL * this.FUEL.kgPerL;
        if (mode === 'drone') return this.orderBlocker(massKg);
        const fuel = this.game.systems.fuel;
        if (fuel.capacity - fuel.current < this.FUEL.lotL - 1e-9) return 'The tank is full';
        return this.game.fabrication.spaceBlocker(massKg, 0);
    }

    buyFuel() {
        if (this.buyFuelBlocker()) return false;
        this.game.credits -= this.fuelLotPrice();
        if (this.tradeMode() === 'drone') this.order({ kind: 'fuel', litres: this.FUEL.lotL });
        else this._deliver({ kind: 'fuel', litres: this.FUEL.lotL });
        return true;
    }

    // Something bought from the yard: it waits in the port hold for a drone run.
    // An order just like the last one (more of the same supply, food or fuel)
    // joins it, so the hold reads "5 × Basic Components" rather than five lines.
    order(entry) {
        const hold = this.game.portHold ?? (this.game.portHold = []);
        const last = hold[hold.length - 1];
        const field = { item: 'count', food: 'rations', fuel: 'litres' }[entry.kind];
        if (field && last?.kind === entry.kind && last.key === entry.key) {
            last[field] += entry[field];
            return last;
        }
        const held = { id: this._newId('hold'), ...entry };
        hold.push(held);
        return held;
    }

    // Selling from the yard: what a drone would carry, or why it can't.
    // `load` is { kind: 'compost' | 'module', boxId }.
    // What a sale would load: a module whole, compost up to the payload.
    _saleMassKg(load) {
        const fab = this.game.fabrication;
        const box = fab._box(load.boxId);
        if (!box) return 0;
        if (load.kind === 'module') return box.module ? fab.moduleMassKg(box.module) : 0;
        return Math.min(box.fillL * fab.BOX.contentDensityKgPerL, this.droneSpec('payloadKg'));
    }

    saleRunBlocker(load) {
        const outKg = this._saleMassKg(load);
        const drone = this.readyDrone(outKg);
        if (!this.drones().length) return 'You need a transfer drone to sell from the yard';
        if (!drone) return this.launchBlocker(this.drones()[0], { forSale: true, outKg }) ?? 'No drone ready';
        if (load.kind === 'module') {
            const box = this.game.fabrication._box(load.boxId);
            if (!box?.module) return 'Nothing stored';
            const mass = this.game.fabrication.moduleMassKg(box.module);
            if (mass > this.droneSpec('payloadKg') + 1e-9) return `Too heavy for a drone (${Math.round(mass)} kg) — sell it at the port`;
        }
        return null;
    }

    // Loads the sale onto a ready drone and launches it. Compost goes up to the
    // drone's payload; what's left stays in the box for another run. Returns
    // what went, or null.
    sendForSale(load) {
        if (this.saleRunBlocker(load)) return null;
        const fab   = this.game.fabrication;
        const box   = fab._box(load.boxId);
        const drone = this.readyDrone(this._saleMassKg(load));
        let entry;
        if (load.kind === 'compost') {
            const litres = Math.min(box.fillL, this.droneSpec('payloadKg') / fab.BOX.contentDensityKgPerL);
            box.fillL -= litres;
            if (box.fillL <= 1e-6) fab._clearBox(box);
            entry = { kind: 'compost', litres };
        } else {
            entry = { kind: 'module', ...box.module };
            box.module = null;
            const unit = `box:${box.id}`;
            this.game.repairQueue = this.game.repairQueue.filter(t => t.systemKey !== unit);
        }
        this.launch(drone.id, [entry]);
        return entry;
    }

    // ── Delivering ──────────────────────────────────────────────────────────

    // Puts as much of `entry` aboard as fits. Returns what's left of it, or null.
    _deliver(entry) {
        const g = this.game, fab = g.fabrication;
        const massFree = () => g._computeShipCapacity().freeMassKg;
        switch (entry.kind) {
            case 'item': {
                const each = fab.ITEMS[entry.key]?.massKg ?? 0;
                const byMass = each > 0 ? Math.floor((massFree() + 1e-9) / each) : entry.count;
                const n = Math.min(entry.count, byMass, fab.partsRoomFor(entry.key));
                if (n > 0) fab.storeParts(entry.key, n);
                return n >= entry.count ? null : { ...entry, count: entry.count - n };
            }
            case 'food': {
                const byMass = Math.floor((massFree() + 1e-9) / fab.FOOD.massKgPerRation);
                const n = Math.min(entry.rations, byMass, Math.floor(fab.foodRoom() + 1e-9));
                if (n > 0) fab._storeRations(n);
                return n >= entry.rations ? null : { ...entry, rations: entry.rations - n };
            }
            case 'fuel': {
                const fuel = g.systems.fuel;
                const n = Math.max(0, Math.min(entry.litres, fuel.capacity - fuel.current, massFree() / this.FUEL.kgPerL));
                fuel.current += n;
                fuel.level = (fuel.current / fuel.capacity) * 100;
                return entry.litres - n <= 1e-6 ? null : { ...entry, litres: entry.litres - n };
            }
            case 'module': {
                if (fab.spaceBlocker(fab.moduleMassKg(entry), 0)) return entry;
                const sys = g.systems[entry.moduleKey];
                const slotFree = sys && (sys.installed === false || sys.destroyed);
                if (entry.dest !== 'store' && slotFree) {
                    g.commsNav.fitModule(entry.moduleKey, entry.repairPct);
                    return null;
                }
                if (fab.emptyMachineBox()) { fab.storeModule(entry); return null; }
                return entry;
            }
            default:
                return null;
        }
    }

    _deliverAll(list) {
        return list.map(e => this._deliver(e)).filter(Boolean);
    }

    // ── Wrecked drives ──────────────────────────────────────────────────────

    stripBlocker(key) {
        const sys = this.game.systems[key];
        if (!sys || sys.installed === false) return 'Already stripped';
        if (!sys.destroyed) return 'Still working';
        if (this.game.repairQueue.some(t => t.kind === 'strip' && t.recipeKey === key)) return 'Already in the work queue';
        const fab = this.game.fabrication;
        const litres = Object.entries(this.STRIP[key].yields).reduce((sum, [k, n]) => sum + fab.partLitres(k) * n, 0);
        if (fab.partsRoomL() < litres - 1e-9) return 'Needs an empty storage box for the parts that come off it';
        return null;
    }

    queueStrip(key) {
        if (this.stripBlocker(key)) return null;
        const hours = this.STRIP[key].hours;
        const task = {
            id: this._newId('strip'), kind: 'strip', recipeKey: key, band: 'Strip for parts',
            totalHours: hours, hoursRemaining: hours, status: 'queued',
        };
        this.game.repairQueue.push(task);
        return task;
    }

    // The wreck comes out of the ship and its usable parts go into a box.
    completeStrip(task) {
        task.status = 'done';
        const sys = this.game.systems[task.recipeKey];
        if (!sys) return;
        sys.installed = false;
        sys.destroyed = false;
        sys.repairPct = 0;
        const yields = this.STRIP[task.recipeKey].yields;
        Object.entries(yields).forEach(([k, n]) => this.game.fabrication.storeParts(k, n, { force: true }));
        const fab = this.game.fabrication;
        const what = Object.entries(yields).map(([k, n]) => `${n} ${fab.ITEMS[k].name.toLowerCase()}`).join(' and ');
        this._notify({ key: `strip:${task.recipeKey}`, level: 'good', title: `${this.DRIVE_NAMES[task.recipeKey]} stripped for parts`, detail: `Recovered ${what}.` });
    }

    // ── Flying ──────────────────────────────────────────────────────────────

    flyBlocker(to) {
        if (this.isFlying()) return 'Already in flight';
        if (this.berth() === to) return 'You\'re already here';
        const t = this.game.systems.thrusters;
        if (!t || t.installed === false) return 'No atmospheric thrusters fitted';
        if (t.destroyed) return 'The thrusters are wrecked';
        // She climbs too high for the vents to do any good, and they must be sealed for it.
        if (this.game.ventsOpen) return 'Close the vents first — she flies too high for them to work';
        const fuelL = this.hopFuelL();
        if (this.game.systems.fuel.current < fuelL - 1e-9) return `Needs ${fuelL} L of fuel`;
        return null;
    }

    // Drones away or parked outside don't come along: each lands (or waits)
    // where she was, and she has to come back for it. Fuel burns as she flies
    // (_updateFlight), not all at lift-off.
    fly(to) {
        if (this.flyBlocker(to)) return false;
        const from = this.berth();
        this.drones().forEach(d => { if (!this.isAboard(d)) d.base = d.base ?? from; });
        const hours = this.hopHours();
        this.game.flight = { to, hoursLeft: hours, totalHours: hours, fuelL: this.hopFuelL() };
        return true;
    }

    // What's left of the hop's fuel bill.
    flightFuelLeftL() {
        const f = this.game.flight;
        if (!f || !(f.totalHours > 0)) return 0;
        return (f.fuelL ?? 0) * Math.max(0, f.hoursLeft) / f.totalHours;
    }

    // ── Per tick ────────────────────────────────────────────────────────────

    // Docked drones charge from spare generator output (SystemUpdate works out
    // how much). How much they could take this tick, in W.
    // With `fromBatteryOnly`, just the drones switched to charge from the ship's
    // battery when spare power runs short (SystemUpdate, DOCK_BATTERY_FLOOR_PCT).
    dockDemandW(dt, { fromBatteryOnly = false } = {}) {
        const hours = dt / 3600;
        if (hours <= 0) return 0;
        const cap = this.droneSpec('batteryWh');
        return this.drones().filter(d => d.state === 'docked' && (!fromBatteryOnly || d.chargeFromBattery)).reduce((sum, d) =>
            sum + Math.min(this.dockSpec('chargeW'), Math.max(0, cap - (d.chargeWh ?? 0)) / hours), 0);
    }

    // The "charge from battery" switch on a drone.
    toggleBatteryCharge(droneId) {
        const drone = this.drone(droneId);
        if (!drone) return false;
        drone.chargeFromBattery = !drone.chargeFromBattery;
        return true;
    }

    // Shares `wh` among docked drones: those switched to charge from the
    // battery first (that energy was drawn for them), then emptiest first.
    chargeDocked(wh) {
        const cap = this.droneSpec('batteryWh');
        let left = wh;
        this.drones().filter(d => d.state === 'docked')
            .sort((a, b) => (b.chargeFromBattery ? 1 : 0) - (a.chargeFromBattery ? 1 : 0) || (a.chargeWh ?? 0) - (b.chargeWh ?? 0))
            .forEach(d => {
                const take = Math.min(left, cap - (d.chargeWh ?? 0));
                if (take > 0) { d.chargeWh = (d.chargeWh ?? 0) + take; left -= take; }
            });
    }

    update(dt) {
        const hours = dt / 3600;
        this._tidyPlans();
        this._updateFlight(hours);
        this.drones().forEach(d => this._updateDrone(d, hours));
        // Anything still to come aboard: a drone's undelivered load, or the
        // port hold while berthed at the port.
        this.drones().filter(d => this.isWithShip(d) && d.cargoIn?.length).forEach(d => { d.cargoIn = this._deliverAll(d.cargoIn); });
        if (this.atPort() && this.game.portHold?.length) {
            const before = this.game.portHold.map(e => this.entryLabel(e));
            this.game.portHold = this._deliverAll(this.game.portHold);
            if (this.game.portHold.length < before.length) {
                this._notify({ key: 'hold:collected', level: 'good', title: 'Collected from the port hold', detail: `${before.length - this.game.portHold.length} order(s) brought aboard.` });
            }
        }
    }

    _updateFlight(hours) {
        const flight = this.game.flight;
        if (!flight) return;
        // The thrusters burn the hop's fuel evenly over the flight. One huge
        // tick only burns what's left of the hop, never more.
        const step = Math.min(hours, Math.max(0, flight.hoursLeft));
        const fuel = this.game.systems.fuel;
        if (flight.totalHours > 0 && step > 0) {
            const rateLhr = (flight.fuelL ?? 0) / flight.totalHours;
            fuel.current  = Math.max(0, fuel.current - rateLhr * step);
            fuel.level    = (fuel.current / fuel.capacity) * 100;
            fuel.consumeRateLhr = (fuel.consumeRateLhr ?? 0) + rateLhr;
        }
        flight.hoursLeft -= hours;
        if (flight.hoursLeft > 1e-9) return;
        this.game.berth  = flight.to;
        this.game.flight = null;
        this._notify({
            key: 'flight', level: 'good', title: `Landed at ${this.berthName()}`,
            detail: this.berth() === 'port' ? 'Trade here is direct — no drone runs needed.' : 'Back at the yard.',
        });
        this._collectWaitingDrones();
        this.game.onLanded?.(this.berth());
    }

    // Landing where drones have been waiting: they come aboard (docked or
    // stowed if there's room, else they stay parked beside her).
    _collectWaitingDrones() {
        const here = this.drones().filter(d => d.state === 'parked' && d.base === this.berth());
        here.forEach(d => this._settleHome(d));
        if (here.length) {
            this._notify({
                key: 'drone:collected', level: 'good',
                title: `Picked up ${here.map(d => this.droneLabel(d)).join(', ')}`,
                detail: here.map(d => `${this.droneLabel(d)}: ${this._whereNote(d)}`).join(' '),
            });
        }
    }

    // One huge tick can carry a drone through several legs; each is taken in turn.
    _updateDrone(drone, hours) {
        let left = hours;
        while (left > 0 && !this.isHome(drone)) {
            const step = Math.min(left, drone.hoursLeft);
            if (drone.state !== 'arriving') this._fly(drone, step);
            drone.hoursLeft -= step;
            left -= step;
            if (drone.hoursLeft > 1e-9) break;
            if (drone.state === 'outbound') this._reachPort(drone);
            else this._reachHome(drone);
        }
    }

    // Charge spent and wear taken over `hours` of flying.
    // Energy per km follows the load on this leg (droneWhPerKm).
    _fly(drone, hours) {
        const km = hours * this.droneSpec('speedKmh');
        const loadKg = this.cargoMassKg(drone.state === 'outbound' ? drone.cargoOut : drone.cargoIn);
        drone.chargeWh = Math.max(0, (drone.chargeWh ?? 0) - km * this.droneWhPerKm(loadKg));
        const wear = this.droneSpec('wearPctPerKm') * (drone.juryRigged ? this.droneSpec('juryRigWearMultiplier') : 1);
        drone.repairPct = Math.max(0, (drone.repairPct ?? 100) - km * wear);
    }

    // At the port: sell what it brought, drop off anything it couldn't unload
    // last time, then load exactly what was planned and head back.
    _reachPort(drone) {
        const g = this.game, fab = g.fabrication;
        let earned = 0;
        (drone.cargoOut ?? []).forEach(e => {
            if (e.kind === 'compost') earned += Math.round(e.litres * fab.COMPOST_PRICE_PER_L);
            if (e.kind === 'module') {
                earned += fab.moduleSaleValue(e);
                const resale = fab._resale();
                resale[e.moduleKey] = (resale[e.moduleKey] ?? 0) + 1;
            }
        });
        if (drone.cargoOut?.length) {
            g.credits += earned;
            this._notify({ key: 'drone:sold', level: 'good', title: `Sold at ${this.PORT_NAME}`, detail: `${drone.cargoOut.map(e => this.entryLabel(e)).join(', ')} — +${earned} credits.` });
        }
        drone.cargoOut = [];

        // Anything it couldn't unload last time goes back into the hold, to be
        // planned again; it doesn't ride along unasked.
        if (drone.cargoIn?.length) {
            g.portHold = [...drone.cargoIn.map(e => ({ ...e, id: e.id ?? this._newId('hold') })), ...(g.portHold ?? [])];
        }

        const load = [];
        this.plan(drone).forEach(p => {
            const entry = this._holdEntry(p.holdId);
            if (!entry) return;
            const { field } = this._entryUnit(entry);
            const qty = Math.min(p.qty, this.entryQty(entry));
            if (qty <= 0) return;
            if (field && qty < entry[field]) {
                load.push({ ...entry, id: this._newId('hold'), [field]: qty });
                entry[field] -= qty;
            } else {
                load.push(entry);
                g.portHold = g.portHold.filter(e => e !== entry);
            }
        });
        drone.plan      = [];
        drone.cargoIn   = load;
        drone.state     = 'returning';
        drone.hoursLeft = this.droneLegHours();
    }

    _reachHome(drone) {
        const arriving = drone.state === 'arriving';
        this._settleHome(drone);
        if (arriving) {
            this._notify({ key: 'drone:arrived', level: 'good', title: `${this.droneLabel(drone)} has arrived`, detail: this._whereNote(drone) });
            return;
        }
        const brought = drone.cargoIn ?? [];
        if (this.isLeftBehind(drone)) {
            const what = brought.length ? ` It has ${brought.map(e => this.entryLabel(e)).join(', ')} aboard.` : '';
            this._notify({ key: 'drone:back', level: 'warning', title: `${this.droneLabel(drone)} landed at ${this.berthName(this.droneBase(drone))}`, detail: `The ship isn't there — fly back to pick it up.${what}` });
            return;
        }
        drone.cargoIn = this._deliverAll(brought);
        const what = brought.length ? brought.map(e => this.entryLabel(e)).join(', ') : 'nothing to collect';
        const stuck = drone.cargoIn.length ? ` No room yet for ${drone.cargoIn.map(e => this.entryLabel(e)).join(', ')} — it stays on the drone.` : '';
        this._notify({ key: 'drone:back', level: 'good', title: `${this.droneLabel(drone)} is back`, detail: `Brought ${what}.${stuck} ${this._whereNote(drone)}` });
    }

    _whereNote(drone) {
        if (this.isLeftBehind(drone)) return `Waiting at ${this.berthName(this.droneBase(drone))} for the ship.`;
        return {
            docked: 'Docked and charging.',
            stowed: 'Stowed aboard — it won\'t charge without a dock.',
            parked: 'Set down outside: no room aboard.',
        }[drone.state] ?? '';
    }

    _notify(entry) {
        this.game.notifications?.add(entry);
    }

    // ── Ship capacity ───────────────────────────────────────────────────────

    capacityItems() {
        const rows = [];
        this.drones().filter(d => this.isAboard(d)).forEach(d => {
            rows.push({ label: `${this.droneLabel(d)} (${d.state})`, count: 1, massKg: this._droneMassKg(d), volumeM3: this.droneSpec('volumeM3') });
        });
        const docks = this.game.droneDocks ?? 0;
        if (docks) rows.push({ label: 'Drone Dock', count: docks, massKg: this.dockSpec('massKg') * docks, volumeM3: this.dockSpec('volumeM3') * docks });
        return rows;
    }
}
