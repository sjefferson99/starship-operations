// Fabrication & cargo domain logic: supplies bought on the market (basic
// components, composting agent, food rations), things engineers fabricate from
// them in the work queue (storage boxes and machine storage boxes), and what
// boxes are used for: food, composting the solid waste that eating produces,
// and keeping spare equipment. Kept separate from main.js for the same reason
// RepairManager, CrewManager and CommsNav are: a self-contained domain the
// dashboard reads.
//
// State lives on the game as `game.cargo`:
//   { items: {}, boxes: [{ id, size, kind, fillL, sealed, compostHours, module, parts }] }
// (`items` held loose supplies before everything went into boxes; a payload
// that still has some has them packed into boxes by GameState.restore.)
//
// There are two sizes of box. A STANDARD box (`size: 'standard'`) holds one
// kind of thing at a time; `kind` is null while it's empty and unassigned.
//   - 'parts':   supplies — basic and precision components and composting
//                agent, mixed (`parts`: { itemKey: count }). Each takes up
//                `litres` of the box (ITEMS); fillL is their total. Supplies
//                bought, and what comes off a stripped drive, fill parts boxes
//                with room first, then claim empty boxes. A parts box used up
//                goes back to unassigned.
//   - 'food':    food rations (fillL counts rations, one litre each). Bought
//                rations go into food boxes with room, then into empty boxes.
//                The crew eat from the emptiest food box first, and a food box
//                that is eaten empty goes back to unassigned.
//   - 'compost': adding composting agent makes it a compost box, which solid
//                waste can then be moved into. Sealing it (by hand, or
//                automatically once full) starts the composting clock; once
//                that has run the box holds compost, which sells on a planet.
//                Selling empties the box back to unassigned.
// A MACHINE box (`size: 'machine'`) is bigger, takes twice the components and
// longer to make, and holds one piece of equipment (`module`: { moduleKey,
// tier, repairPct, juryRigged, destroyed }) without it needing a dashboard
// slot. A stored module doesn't run or wear. It can be repaired in the work
// queue (RepairManager knows it as the unit key `box:<boxId>`), swapped with
// the fitted one, or sold on a planet for what its condition is worth — the
// buy-salvage, repair, sell-at-a-profit loop.
//
// Fabrication jobs share the repair work queue (game.repairQueue) as tasks with
// `kind: 'fabricate'` (and stripping a wrecked drive, `kind: 'strip'`, see
// logistics.js). RepairManager works them like any other task and calls
// completeTask() when the hours are done.
//
// Buying needs the market in reach (Logistics.tradeMode): at the port it comes
// straight aboard; from Harlow's yard it waits at the port for a drone run.

class Fabrication {
    static _boxSeq = 0; // makes box ids unique within a page session

    constructor(game) {
        this.game = game;

        // Market supplies, kept in parts boxes. Unlimited stock wherever you can trade.
        // `litres` is the room one takes in a storage box.
        this.ITEMS = {
            basicComponents: {
                name: 'Basic Components', price: 60, massKg: 5, litres: 4,
                blurb: 'Standard plate, fixings and seals. Engineers fabricate simple things from them.',
            },
            precisionComponents: {
                name: 'Precision Components', price: 150, massKg: 2, litres: 2,
                blurb: 'Machined bearings, injectors and control boards — what drives and docks are built from.',
            },
            compostingAgent: {
                name: 'Composting Agent', price: 30, massKg: 1, litres: 1,
                blurb: 'One dose readies an empty storage box to take solid waste and turn it into compost.',
            },
        };

        // Food is sold by the case and lives in storage boxes, not loose in `items`.
        // One ration is one meal; meal times are SystemUpdate.MEAL_HOURS.
        this.FOOD = {
            name: 'Food Rations', caseSize: 10, price: 30, massKgPerRation: 1,
            blurb: 'A case of 10 meal rations. Kept in a storage box of its own.',
        };
        this.STARTER_RATIONS      = 15; // aboard a new ship, in its one storage box: 5 days for one

        // What engineers can make. `components` are taken from the parts boxes
        // when the job is queued (and handed back if it's cancelled). `makes`
        // is what the finished job adds: a box of `size`, a drone dock, or a
        // fitted module.
        this.RECIPES = {
            storageBox: { name: 'Storage Box',         components: { basicComponents: 1 }, hours: 4,  makes: 'box', size: 'standard' },
            machineBox: { name: 'Machine Storage Box', components: { basicComponents: 2 }, hours: 10, makes: 'box', size: 'machine' },
            droneDock:  { name: 'Drone Dock',          components: { precisionComponents: 1, basicComponents: 2 }, hours: 24, makes: 'dock' },
            thrusters:  { name: 'Atmospheric Thrusters', components: { precisionComponents: 10, basicComponents: 12 }, hours: 72, makes: 'module', moduleKey: 'thrusters' },
        };

        // A box takes up the same space however full it is; its mass grows with
        // what's in it. A machine box is big enough for the largest module.
        this.BOX         = { capacityL: 50, emptyMassKg: 6, volumeM3: 0.08, contentDensityKgPerL: 1.0 };
        this.MACHINE_BOX = { emptyMassKg: 18, volumeM3: 0.9 };

        this.COMPOST_HOURS       = 72; // game hours from sealing to compost
        this.COMPOST_PRICE_PER_L = 4;  // what a planet pays per litre of finished compost
        this.MIN_TRANSFER_L      = 0.01;

        // What a planet pays for a stored module, by condition on a curve
        // (MODULE_SELL_CURVE): a damaged unit fetches little — less than
        // CommsNav's 100–200 credit asking price for 8–45% salvage, so there's
        // nothing in reselling it unrepaired — and a working one a lot. A repair
        // is where the money is: 45% salvage at ~200 cr sells for 750 once fixed.
        // Jury-rigged units fetch less; destroyed ones are scrap.
        this.MODULE_SELL_MIN       = 40;
        this.MODULE_SELL_MAX       = 750;
        this.MODULE_SELL_CURVE     = 2;
        this.MODULE_JURY_RIG_VALUE = 0.6;
        this.MODULE_SCRAP_PRICE    = 15;

        // Selling floods the market: each recent sale of a module type cuts
        // what the next one of that type fetches by MODULE_RESALE_DROP, and
        // each sale's effect wears off over MODULE_RESALE_RECOVERY_DAYS. Gentle:
        // it takes a run of sales close together to really dent the price.
        // State: game.moduleResale = { moduleKey: recent sales (fractional) }.
        this.MODULE_RESALE_DROP          = 0.1;
        this.MODULE_RESALE_RECOVERY_DAYS = 4;

        this.MODULE_NAMES = {
            o2: 'O₂ Generator', co2: 'CO₂ Scrubber', power: 'Power Generator',
            transceiver: 'Transceiver', waterMaker: 'Water Maker',
            thrusters: 'Atmospheric Thrusters', ionDrive: 'Ion Drive',
        };

        // Page-session counter of swaps, so the observers (notifications.js,
        // sound.js) can tell a swap from a repair landing. Not game state.
        this.swapCount = 0;
    }

    static defaultCargo() {
        return { items: {}, boxes: [] };
    }

    static _newBoxId() {
        return `box-${Date.now().toString(36)}-${++Fabrication._boxSeq}`;
    }

    _cargo() {
        if (!this.game.cargo) this.game.cargo = Fabrication.defaultCargo();
        return this.game.cargo;
    }

    // How many of a supply are aboard, across every parts box.
    count(itemKey) {
        return this.partsBoxes().reduce((sum, b) => sum + (b.parts?.[itemKey] ?? 0), 0);
    }

    // ── Parts boxes ─────────────────────────────────────────────────────────

    partsBoxes() {
        return this.boxes().filter(b => b.kind === 'parts');
    }

    partLitres(itemKey) {
        return this.ITEMS[itemKey]?.litres ?? 1;
    }

    _partsFillL(box) {
        return Object.entries(box.parts ?? {}).reduce((sum, [k, n]) => sum + this.partLitres(k) * n, 0);
    }

    // Litres free for supplies: room in parts boxes plus every empty standard box.
    partsRoomL() {
        return this.standardBoxes().reduce((room, b) => {
            if (b.kind === 'parts') return room + Math.max(0, this.BOX.capacityL - this._partsFillL(b));
            if (!b.kind) return room + this.BOX.capacityL;
            return room;
        }, 0);
    }

    // How many of `itemKey` could be put away right now (box by box, since a
    // unit can't be split across two boxes).
    partsRoomFor(itemKey) {
        const l = this.partLitres(itemKey);
        return this.standardBoxes().reduce((n, b) => {
            if (b.kind === 'parts') return n + Math.floor((this.BOX.capacityL - this._partsFillL(b) + 1e-9) / l);
            if (!b.kind) return n + Math.floor((this.BOX.capacityL + 1e-9) / l);
            return n;
        }, 0);
    }

    // Puts `n` of a supply into parts boxes, fullest first, then claims empty
    // boxes. With `force` (a refund, or parts off a stripped drive, which have
    // to go somewhere), anything left over goes into a parts box regardless —
    // or a new box if there's none. Returns how many were put away.
    storeParts(itemKey, n, { force = false } = {}) {
        const l = this.partLitres(itemKey);
        let left = n;
        const put = box => {
            const fit = Math.min(left, Math.floor((this.BOX.capacityL - this._partsFillL(box) + 1e-9) / l));
            if (fit <= 0) return;
            box.parts[itemKey] = (box.parts[itemKey] ?? 0) + fit;
            box.fillL = this._partsFillL(box);
            left -= fit;
        };
        this.partsBoxes().slice().sort((a, b) => b.fillL - a.fillL).forEach(box => { if (left > 0) put(box); });
        this.standardBoxes().filter(b => !b.kind).forEach(box => {
            if (left <= 0) return;
            this._clearBox(box);
            box.kind = 'parts';
            box.parts = {};
            put(box);
            if (!this._partsFillL(box)) this._clearBox(box);
        });
        if (left > 0 && force) {
            let box = this.partsBoxes()[0];
            if (!box) {
                box = this._emptyBox('standard');
                box.kind = 'parts';
                box.parts = {};
                this.boxes().push(box);
            }
            box.parts[itemKey] = (box.parts[itemKey] ?? 0) + left;
            box.fillL = this._partsFillL(box);
            left = 0;
        }
        return n - left;
    }

    // Takes `n` of a supply out, from the emptiest parts box first; a box left
    // with nothing in it goes back to unassigned. Returns how many were taken.
    takeParts(itemKey, n) {
        let left = n;
        this.partsBoxes().slice().sort((a, b) => a.fillL - b.fillL).forEach(box => {
            const have = box.parts?.[itemKey] ?? 0;
            if (left <= 0 || have <= 0) return;
            const take = Math.min(left, have);
            box.parts[itemKey] = have - take;
            if (!box.parts[itemKey]) delete box.parts[itemKey];
            box.fillL = this._partsFillL(box);
            left -= take;
            if (!Object.keys(box.parts).length) this._clearBox(box);
        });
        return n - left;
    }

    _partsMassKg(box) {
        return Object.entries(box.parts ?? {}).reduce((sum, [k, n]) => sum + (this.ITEMS[k]?.massKg ?? 0) * n, 0);
    }

    boxes() {
        return this._cargo().boxes;
    }

    _box(boxId) {
        return this.boxes().find(b => b.id === boxId) ?? null;
    }

    isMachineBox(box) {
        return box?.size === 'machine';
    }

    standardBoxes() {
        return this.boxes().filter(b => !this.isMachineBox(b));
    }

    machineBoxes() {
        return this.boxes().filter(b => this.isMachineBox(b));
    }

    // "Storage Box 2", "Machine Box 1": numbered within their own size.
    boxLabel(box) {
        const machine = this.isMachineBox(box);
        const n = this.boxes().filter(b => this.isMachineBox(b) === machine).indexOf(box) + 1;
        return `${machine ? 'Machine Box' : 'Storage Box'} ${n}`;
    }

    _emptyBox(size = 'standard') {
        return { id: Fabrication._newBoxId(), size, kind: null, fillL: 0, sealed: false, compostHours: 0, module: null, parts: null };
    }

    // An empty standard box to go with the food a new ship starts with, kept
    // for what comes off the wrecked drives.
    addStarterBox() {
        const box = this._emptyBox('standard');
        this.boxes().push(box);
        return box;
    }

    // ── Box lifecycle ───────────────────────────────────────────────────────

    // Standard: 'empty' → 'food' | 'parts', or 'empty' → 'filling' → 'composting' → 'ready'.
    // Machine:  'empty' ↔ 'stored'.
    boxStatus(box) {
        if (this.isMachineBox(box)) return box.module ? 'stored' : 'empty';
        if (!box.kind) return 'empty';
        if (box.kind === 'food') return 'food';
        if (box.kind === 'parts') return 'parts';
        if (!box.sealed) return 'filling';
        return box.compostHours >= this.COMPOST_HOURS ? 'ready' : 'composting';
    }

    boxMassKg(box) {
        if (this.isMachineBox(box)) {
            return this.MACHINE_BOX.emptyMassKg + (box.module ? this.moduleMassKg(box.module) : 0);
        }
        if (box.kind === 'parts') return this.BOX.emptyMassKg + this._partsMassKg(box);
        return this.BOX.emptyMassKg + (box.fillL ?? 0) * this.BOX.contentDensityKgPerL;
    }

    boxVolumeM3(box) {
        return this.isMachineBox(box) ? this.MACHINE_BOX.volumeM3 : this.BOX.volumeM3;
    }

    // Per-tick: sealed compost boxes work toward compost. Pure accumulation,
    // clamped, so one huge tick at 1000× is fine.
    update(dt) {
        const hours = dt / 3600;
        this.boxes().forEach(box => {
            if (box.kind === 'compost' && box.sealed && box.compostHours < this.COMPOST_HOURS) {
                box.compostHours = Math.min(this.COMPOST_HOURS, box.compostHours + hours);
            }
        });
        // Recent sales wear off — clamped at zero, so a huge tick is fine.
        const resale = this._resale();
        const recovered = dt / (this.MODULE_RESALE_RECOVERY_DAYS * 86400);
        Object.keys(resale).forEach(key => {
            resale[key] = Math.max(0, resale[key] - recovered);
            if (resale[key] <= 0) delete resale[key];
        });
    }

    hoursUntilCompost(box) {
        return Math.max(0, this.COMPOST_HOURS - (box.compostHours ?? 0));
    }

    doseBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (this.isMachineBox(box)) return 'A machine box only holds equipment';
        if (box.kind) return 'Already in use';
        if (this.count('compostingAgent') < 1) return 'No composting agent aboard';
        return null;
    }

    dose(boxId) {
        if (this.doseBlocker(boxId)) return false;
        const box = this._box(boxId);
        this.takeParts('compostingAgent', 1);
        box.kind = 'compost';
        box.fillL = 0;
        box.sealed = false;
        box.compostHours = 0;
        return true;
    }

    // How much solid waste could go into this box right now (litres). No mass
    // check: the tank gets lighter by exactly what the box gains.
    transferableL(box) {
        if (!box || box.kind !== 'compost' || box.sealed) return 0;
        const room   = Math.max(0, this.BOX.capacityL - box.fillL);
        const solids = Math.max(0, this.game.systems.blackWater.solidL);
        return Math.min(room, solids);
    }

    transferBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind !== 'compost') return 'Add composting agent first';
        if (box.sealed) return 'Sealed';
        if (box.fillL >= this.BOX.capacityL) return 'Full';
        if (this.game.systems.blackWater.solidL < this.MIN_TRANSFER_L) return 'No solid waste in the tank';
        return null;
    }

    // Moves as much solid waste as fits from the black water tank into the
    // box. A box that ends up full seals itself. Returns litres moved.
    transferSolids(boxId) {
        if (this.transferBlocker(boxId)) return 0;
        const box = this._box(boxId);
        const moved = this.transferableL(box);
        const black = this.game.systems.blackWater;
        black.solidL = Math.max(0, black.solidL - moved);
        this.game.syncBlackWaterLevel();
        box.fillL = Math.min(this.BOX.capacityL, box.fillL + moved);
        if (box.fillL >= this.BOX.capacityL - 1e-9) this.seal(boxId);
        return moved;
    }

    // The box solid waste goes into from the Black Water card: the fullest box
    // still taking it (so boxes fill one at a time), or null.
    transferTarget() {
        const open = this.boxes().filter(b => b.kind === 'compost' && !b.sealed && b.fillL < this.BOX.capacityL);
        if (!open.length) return null;
        return open.reduce((best, b) => (b.fillL > best.fillL ? b : best));
    }

    sealBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind !== 'compost') return 'Nothing to seal';
        if (box.sealed) return 'Already sealed';
        if (box.fillL < this.MIN_TRANSFER_L) return 'Empty — move some solid waste in first';
        return null;
    }

    seal(boxId) {
        const box = this._box(boxId);
        if (!box || box.kind !== 'compost' || box.sealed || box.fillL < this.MIN_TRANSFER_L) return false;
        box.sealed = true;
        box.compostHours = 0;
        return true;
    }

    salePrice(box) {
        return Math.round((box.fillL ?? 0) * this.COMPOST_PRICE_PER_L);
    }

    sellBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (this.boxStatus(box) !== 'ready') return 'Not compost yet';
        const mode = this.game.logistics.tradeMode();
        if (!mode) return this.game.logistics.tradeBlocker();
        if (mode === 'drone') return this.game.logistics.saleRunBlocker({ kind: 'compost', boxId });
        return null;
    }

    // Sells the compost; the box goes back to empty and unassigned. From the
    // yard it goes by drone instead (up to a drone's load), and is paid for at
    // the port — that returns 0 here.
    sell(boxId) {
        if (this.sellBlocker(boxId)) return 0;
        if (this.game.logistics.tradeMode() === 'drone') {
            this.game.logistics.sendForSale({ kind: 'compost', boxId });
            return 0;
        }
        const box = this._box(boxId);
        const price = this.salePrice(box);
        this.game.credits += price;
        this._clearBox(box);
        return price;
    }

    // Finished compost tipped out instead of sold, so the box can be used for
    // something else. Free; the compost is simply lost. Only once it's ready.
    emptyBlocker(boxId) {
        const box = this._box(boxId);
        if (!box) return 'No such box';
        if (box.kind !== 'compost') return 'Only a compost box can be tipped out';
        if (this.boxStatus(box) !== 'ready') return 'Only finished compost can be tipped out';
        return null;
    }

    emptyBox(boxId) {
        if (this.emptyBlocker(boxId)) return false;
        this._clearBox(this._box(boxId));
        return true;
    }

    _clearBox(box) {
        box.kind = null;
        box.fillL = 0;
        box.sealed = false;
        box.compostHours = 0;
        box.parts = null;
    }

    // ── Food ────────────────────────────────────────────────────────────────

    foodBoxes() {
        return this.boxes().filter(b => b.kind === 'food');
    }

    rationsAboard() {
        return this.foodBoxes().reduce((sum, b) => sum + (b.fillL ?? 0), 0);
    }

    // Rations that could be stored right now: room left in food boxes plus every empty standard box.
    foodRoom() {
        return this.boxes().reduce((room, b) => {
            if (b.kind === 'food') return room + Math.max(0, this.BOX.capacityL - b.fillL);
            if (!this.isMachineBox(b) && !b.kind) return room + this.BOX.capacityL;
            return room;
        }, 0);
    }

    // Puts `rations` into food boxes, topping up the fullest first, then
    // claiming empty boxes. Returns how many fitted.
    _storeRations(rations) {
        let left = rations;
        const fill = box => {
            const put = Math.min(left, this.BOX.capacityL - box.fillL);
            box.fillL += put;
            left -= put;
        };
        this.foodBoxes().slice().sort((a, b) => b.fillL - a.fillL).forEach(box => { if (left > 1e-9) fill(box); });
        this.standardBoxes().filter(b => !b.kind).forEach(box => {
            if (left <= 1e-9) return;
            this._clearBox(box);
            box.kind = 'food';
            fill(box);
        });
        return rations - left;
    }

    // A new ship starts with one storage box of food.
    addStarterFood() {
        const box = this._emptyBox('standard');
        box.kind = 'food';
        box.fillL = this.STARTER_RATIONS;
        this.boxes().push(box);
        return box;
    }

    // The crew eat `wanted` rations, from the emptiest food box first so boxes
    // free up one at a time. A box eaten empty goes back to unassigned.
    // Returns how much was actually eaten (less than wanted when food runs out).
    eat(wanted) {
        if (wanted <= 0) return 0;
        let left = wanted;
        this.foodBoxes().slice().sort((a, b) => a.fillL - b.fillL).forEach(box => {
            if (left <= 0) return;
            const take = Math.min(left, box.fillL);
            box.fillL -= take;
            left -= take;
            if (box.fillL <= 1e-6) this._clearBox(box);
        });
        return wanted - left;
    }

    buyFoodBlocker() {
        const mode = this.game.logistics.tradeMode();
        if (!mode) return this.game.logistics.tradeBlocker();
        if (this.game.credits < this.FOOD.price) return 'Not enough credits';
        const massKg = this.FOOD.caseSize * this.FOOD.massKgPerRation;
        if (mode === 'drone') return this.game.logistics.orderBlocker(massKg);
        if (this.foodRoom() < this.FOOD.caseSize - 1e-9) {
            return 'No storage box with room for food — fabricate a storage box, or empty one';
        }
        // A box takes the same room full or empty, so only the mass is new.
        return this.spaceBlocker(massKg, 0);
    }

    buyFood() {
        if (this.buyFoodBlocker()) return false;
        this.game.credits -= this.FOOD.price;
        if (this.game.logistics.tradeMode() === 'drone') this.game.logistics.order({ kind: 'food', rations: this.FOOD.caseSize });
        else this._storeRations(this.FOOD.caseSize);
        return true;
    }

    // ── Buying supplies ─────────────────────────────────────────────────────

    _canTrade() {
        return this.game.commsNav.canTradeAt(this.game.commsNav.home());
    }

    // null if the change fits in the ship, otherwise why not.
    spaceBlocker(addMassKg, addVolumeM3) {
        const cap = this.game._computeShipCapacity();
        if (addVolumeM3 > 0 && cap.freeVolumeM3 < addVolumeM3 - 1e-9) return 'Not enough free volume aboard';
        if (addMassKg > 0 && cap.freeMassKg < addMassKg - 1e-9) return 'Over the ship\'s mass limit';
        return null;
    }

    buyBlocker(itemKey) {
        const item = this.ITEMS[itemKey];
        if (!item) return 'Not sold here';
        const mode = this.game.logistics.tradeMode();
        if (!mode) return this.game.logistics.tradeBlocker();
        if (this.game.credits < item.price) return 'Not enough credits';
        if (mode === 'drone') return this.game.logistics.orderBlocker(item.massKg);
        if (this.partsRoomFor(itemKey) < 1) return 'No storage box with room — fabricate a storage box, or empty one';
        return this.spaceBlocker(item.massKg, 0);
    }

    buy(itemKey) {
        if (this.buyBlocker(itemKey)) return false;
        this.game.credits -= this.ITEMS[itemKey].price;
        if (this.game.logistics.tradeMode() === 'drone') this.game.logistics.order({ kind: 'item', key: itemKey, count: 1 });
        else this.storeParts(itemKey, 1);
        return true;
    }

    // ── Machine boxes: stored equipment ─────────────────────────────────────

    // module_specs.json name for a system key (same mapping as RepairManager).
    _moduleType(moduleKey) {
        return { o2: 'o2Generator', co2: 'co2Scrubber', power: 'generator' }[moduleKey] ?? moduleKey;
    }

    moduleMassKg(module) {
        return this.game._moduleField(this._moduleType(module.moduleKey), module.tier ?? 1, 'massKg', 0);
    }

    moduleName(moduleKey) {
        return this.MODULE_NAMES[moduleKey] ?? moduleKey;
    }

    storedModule(boxId) {
        return this._box(boxId)?.module ?? null;
    }

    // Unit keys (see RepairManager) for every module sitting in a machine box.
    storedUnitKeys() {
        return this.machineBoxes().filter(b => b.module).map(b => `box:${b.id}`);
    }

    emptyMachineBox() {
        return this.machineBoxes().find(b => !b.module) ?? null;
    }

    // Puts a bought module straight into an empty machine box.
    storeModule(module) {
        const box = this.emptyMachineBox();
        if (!box) return null;
        box.module = {
            moduleKey: module.moduleKey, tier: module.tier ?? 1,
            repairPct: module.repairPct ?? 100, juryRigged: !!module.juryRigged, destroyed: !!module.destroyed,
        };
        return box;
    }

    _resale() {
        if (!this.game.moduleResale) this.game.moduleResale = {};
        return this.game.moduleResale;
    }

    // 1 when nothing of this type has been sold lately, lower after each recent sale.
    resaleFactor(moduleKey) {
        return Math.pow(1 - this.MODULE_RESALE_DROP, this._resale()[moduleKey] ?? 0);
    }

    moduleSaleValue(module) {
        if (!module) return 0;
        const factor = this.resaleFactor(module.moduleKey);
        if (module.destroyed) return Math.round(this.MODULE_SCRAP_PRICE * factor);
        const pct   = Math.max(0, Math.min(100, module.repairPct ?? 100)) / 100;
        const value = this.MODULE_SELL_MIN + Math.pow(pct, this.MODULE_SELL_CURVE) * (this.MODULE_SELL_MAX - this.MODULE_SELL_MIN);
        return Math.round(value * (module.juryRigged ? this.MODULE_JURY_RIG_VALUE : 1) * factor);
    }

    sellModuleBlocker(boxId) {
        const box = this._box(boxId);
        if (!box || !box.module) return 'Nothing stored';
        const mode = this.game.logistics.tradeMode();
        if (!mode) return this.game.logistics.tradeBlocker();
        if (mode === 'drone') return this.game.logistics.saleRunBlocker({ kind: 'module', boxId });
        return null;
    }

    // Sells the stored module (any repair queued on it goes with it). From the
    // yard it goes by drone and is paid for at the port — that returns 0 here.
    sellModule(boxId) {
        if (this.sellModuleBlocker(boxId)) return 0;
        if (this.game.logistics.tradeMode() === 'drone') {
            this.game.logistics.sendForSale({ kind: 'module', boxId });
            return 0;
        }
        const box   = this._box(boxId);
        const price = this.moduleSaleValue(box.module);
        this.game.credits += price;
        const resale = this._resale();
        resale[box.module.moduleKey] = (resale[box.module.moduleKey] ?? 0) + 1;
        box.module = null;
        const unit = `box:${boxId}`;
        this.game.repairQueue = this.game.repairQueue.filter(t => t.systemKey !== unit);
        return price;
    }

    swapBlocker(boxId) {
        const box = this._box(boxId);
        if (!box || !box.module) return 'Nothing stored';
        const sys = this.game.systems[box.module.moduleKey];
        if (!sys) return 'Not compatible with this ship';
        if (box.module.destroyed) return 'Wrecked — it can only be sold for scrap';
        return null;
    }

    // Fits the stored module. Whatever was fitted (working, worn or wrecked)
    // goes into the box in its place; if the slot was empty the box ends up
    // empty. Queued repairs follow the unit they were ordered for.
    swap(boxId) {
        if (this.swapBlocker(boxId)) return false;
        const box    = this._box(boxId);
        const stored = box.module;
        const key    = stored.moduleKey;
        const sys    = this.game.systems[key];
        const wasFitted = sys.installed !== false;

        box.module = wasFitted
            ? { moduleKey: key, tier: sys.tier ?? 1, repairPct: sys.repairPct ?? 100, juryRigged: !!sys.juryRigged, destroyed: !!sys.destroyed }
            : null;

        sys.installed  = true;
        sys.active     = false;
        sys.tier       = stored.tier ?? 1;
        sys.repairPct  = stored.repairPct ?? 100;
        sys.juryRigged = !!stored.juryRigged;
        sys.destroyed  = !!stored.destroyed;

        const unit = `box:${boxId}`;
        this.game.repairQueue.forEach(t => {
            if (t.kind === 'fabricate') return;
            if (t.systemKey === key) t.systemKey = unit;
            else if (t.systemKey === unit) t.systemKey = key;
        });
        // A wrecked unit going into the box can't be repaired.
        if (box.module?.destroyed) this.game.repairQueue = this.game.repairQueue.filter(t => t.systemKey !== unit);
        this.swapCount++;
        return true;
    }

    // ── Fabrication jobs ────────────────────────────────────────────────────

    // Mass and volume of what a recipe makes.
    _recipeProduct(recipe) {
        if (recipe.makes === 'dock') {
            return { massKg: this.game.logistics.dockSpec('massKg'), volumeM3: this.game.logistics.dockSpec('volumeM3') };
        }
        if (recipe.makes === 'module') {
            return {
                massKg:   this.game._moduleField(recipe.moduleKey, 1, 'massKg', 0),
                volumeM3: this.game._moduleField(recipe.moduleKey, 1, 'volumeM3', 0),
            };
        }
        return recipe.size === 'machine'
            ? { massKg: this.MACHINE_BOX.emptyMassKg, volumeM3: this.MACHINE_BOX.volumeM3 }
            : { massKg: this.BOX.emptyMassKg,         volumeM3: this.BOX.volumeM3 };
    }

    // "10 precision + 12 basic components"
    componentsLabel(recipe) {
        const parts = Object.entries(recipe.components);
        const total = parts.reduce((sum, [, n]) => sum + n, 0);
        return parts
            .map(([k, n]) => `${n} ${this.ITEMS[k].name.toLowerCase().replace(' components', '')}`)
            .join(' + ') + (total === 1 ? ' component' : ' components');
    }

    // Queued jobs already hold their components; what they'll make is counted
    // against ship space from the moment they're queued.
    queuedJobs() {
        return (this.game.repairQueue || []).filter(t => t.kind === 'fabricate');
    }

    fabricateBlocker(recipeKey) {
        const recipe = this.RECIPES[recipeKey];
        if (!recipe) return 'Unknown recipe';
        if (recipe.makes === 'module') {
            const sys = this.game.systems[recipe.moduleKey];
            if (sys && sys.installed !== false) {
                return sys.destroyed ? `Strip the wrecked ${recipe.name.toLowerCase()} for parts first` : 'Already fitted';
            }
            if (this.queuedJobs().some(t => t.recipeKey === recipeKey)) return 'Already being made';
        }
        const short = Object.entries(recipe.components).filter(([k, n]) => this.count(k) < n);
        if (short.length) {
            return 'Needs ' + short.map(([k, n]) => `${n} ${this.ITEMS[k].name.toLowerCase()} (${this.count(k)} aboard)`).join(' and ');
        }
        // The components leave their boxes and the product takes their place.
        const used = Object.entries(recipe.components).reduce((sum, [k, n]) => sum + this.ITEMS[k].massKg * n, 0);
        const made = this._recipeProduct(recipe);
        return this.spaceBlocker(made.massKg - used, made.volumeM3);
    }

    queueFabrication(recipeKey) {
        if (this.fabricateBlocker(recipeKey)) return null;
        const recipe = this.RECIPES[recipeKey];
        Object.entries(recipe.components).forEach(([k, n]) => this.takeParts(k, n));
        const task = {
            // Unique id without a roll (see RepairManager.startRepair).
            id: `fab-${Date.now().toString(36)}-${++Fabrication._boxSeq}`,
            kind: 'fabricate',
            recipeKey,
            band: 'Fabricate',
            totalHours: recipe.hours,
            hoursRemaining: recipe.hours,
            status: 'queued',
        };
        this.game.repairQueue.push(task);
        return task;
    }

    // A cancelled job gives its components back.
    refund(task) {
        const recipe = this.RECIPES[task.recipeKey];
        if (recipe) Object.entries(recipe.components).forEach(([k, n]) => this.storeParts(k, n, { force: true }));
    }

    // A finished job (fabrication or stripping a drive) delivers its result.
    completeTask(task) {
        if (task.kind === 'strip') { this.game.logistics.completeStrip(task); return; }
        const recipe = this.RECIPES[task.recipeKey];
        task.status = 'done';
        if (!recipe) return;
        if (recipe.makes === 'dock') {
            this.game.droneDocks = (this.game.droneDocks ?? 0) + 1;
            this.game.notifications?.add({ key: 'fab:droneDock', level: 'good', title: 'Drone dock fabricated', detail: 'Dock a drone on it to charge from spare generator power.' });
        } else if (recipe.makes === 'module') {
            const sys = this.game.systems[recipe.moduleKey];
            Object.assign(sys, { installed: true, destroyed: false, juryRigged: false, repairPct: 100, active: false });
            this.game.notifications?.add({ key: `fab:${task.recipeKey}`, level: 'good', title: `${recipe.name} fitted`, detail: 'Built new in the work queue.' });
        } else {
            this.boxes().push(this._emptyBox(recipe.size));
        }
    }

    // ── Ship capacity rows ──────────────────────────────────────────────────

    capacityItems() {
        const rows = [];
        this.boxes().forEach(box => {
            const what = box.kind === 'food' ? ' (food)'
                : box.kind === 'parts' ? ' (parts)'
                : box.module ? ` (${this.moduleName(box.module.moduleKey)})` : '';
            rows.push({ label: this.boxLabel(box) + what, count: 1, massKg: this.boxMassKg(box), volumeM3: this.boxVolumeM3(box) });
        });
        Object.entries(this.RECIPES).forEach(([key, recipe]) => {
            const pending = this.queuedJobs().filter(t => t.recipeKey === key).length;
            if (!pending) return;
            const made = this._recipeProduct(recipe);
            rows.push({ label: `${recipe.name} (being made)`, count: pending, massKg: made.massKg * pending, volumeM3: made.volumeM3 * pending });
        });
        return rows;
    }
}
