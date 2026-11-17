// Fabrication & cargo domain logic: supplies bought on the market (basic
// components, composting agent, food rations), things engineers fabricate from
// them in the work queue (storage boxes and machine storage boxes), and what
// boxes are used for: food, composting the solid waste that eating produces,
// and keeping spare equipment. Kept separate from main.js for the same reason
// RepairManager, CrewManager and CommsNav are: a self-contained domain the
// dashboard reads.
//
// State lives on the game as `game.cargo`:
//   { items: { basicComponents: n, compostingAgent: n },
//     boxes: [{ id, size, kind, fillL, sealed, compostHours, module }] }
//
// There are two sizes of box. A STANDARD box (`size: 'standard'`) holds one
// kind of thing at a time; `kind` is null while it's empty and unassigned.
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
// `kind: 'fabricate'`. RepairManager works them like any other task and calls
// completeTask() when the hours are done.

class Fabrication {
    static _boxSeq = 0; // makes box ids unique within a page session

    constructor(game) {
        this.game = game;

        // Market supplies counted in `cargo.items`. Unlimited stock on any planet you can trade at.
        this.ITEMS = {
            basicComponents: {
                name: 'Basic Components', price: 60, massKg: 5, volumeM3: 0.02,
                blurb: 'Standard plate, fixings and seals. Engineers fabricate simple things from them.',
            },
            compostingAgent: {
                name: 'Composting Agent', price: 30, massKg: 1, volumeM3: 0.005,
                blurb: 'One dose readies an empty storage box to take solid waste and turn it into compost.',
            },
        };

        // Food is sold by the case and lives in storage boxes, not loose in `items`.
        // One ration is one meal; each crew member eats RATIONS_PER_CREW_DAY.
        this.FOOD = {
            name: 'Food Rations', caseSize: 10, price: 30, massKgPerRation: 1,
            blurb: 'A case of 10 meal rations. Kept in a storage box of its own.',
        };
        this.RATIONS_PER_CREW_DAY = 3;  // three meals
        this.STARTER_RATIONS      = 15; // aboard a new ship, in its one storage box: 5 days for one

        // What engineers can make. `components` basic components are taken
        // when the job is queued (and handed back if it's cancelled).
        this.RECIPES = {
            storageBox: { name: 'Storage Box',         components: 1, hours: 4,  size: 'standard' },
            machineBox: { name: 'Machine Storage Box', components: 2, hours: 10, size: 'machine' },
        };

        // A box takes up the same space however full it is; its mass grows with
        // what's in it. A machine box is big enough for the largest module.
        this.BOX         = { capacityL: 50, emptyMassKg: 6, volumeM3: 0.08, contentDensityKgPerL: 1.0 };
        this.MACHINE_BOX = { emptyMassKg: 18, volumeM3: 0.9 };

        this.COMPOST_HOURS       = 72; // game hours from sealing to compost
        this.COMPOST_PRICE_PER_L = 4;  // what a planet pays per litre of finished compost
        this.MIN_TRANSFER_L      = 0.01;

        // What a planet pays for a stored module: a straight line by condition
        // (compare CommsNav's 100–200 credit asking prices for 8–45% salvage).
        // Jury-rigged units fetch less; destroyed ones are scrap.
        this.MODULE_SELL_MIN       = 40;
        this.MODULE_SELL_MAX       = 400;
        this.MODULE_JURY_RIG_VALUE = 0.6;
        this.MODULE_SCRAP_PRICE    = 15;

        // Selling floods the market: each recent sale of a module type cuts
        // what the next one of that type fetches by MODULE_RESALE_DROP, and
        // each sale's effect wears off over MODULE_RESALE_RECOVERY_DAYS.
        // State: game.moduleResale = { moduleKey: recent sales (fractional) }.
        this.MODULE_RESALE_DROP          = 0.2;
        this.MODULE_RESALE_RECOVERY_DAYS = 10;

        this.MODULE_NAMES = {
            o2: 'O₂ Generator', co2: 'CO₂ Scrubber', power: 'Power Generator',
            transceiver: 'Transceiver', waterMaker: 'Water Maker',
        };

        // Page-session counter of swaps, so the observers (notifications.js,
        // sound.js) can tell a swap from a repair landing. Not game state.
        this.swapCount = 0;
    }

    static defaultCargo() {
        return { items: { basicComponents: 0, compostingAgent: 0 }, boxes: [] };
    }

    static _newBoxId() {
        return `box-${Date.now().toString(36)}-${++Fabrication._boxSeq}`;
    }

    _cargo() {
        if (!this.game.cargo) this.game.cargo = Fabrication.defaultCargo();
        return this.game.cargo;
    }

    count(itemKey) {
        return this._cargo().items[itemKey] ?? 0;
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
        return { id: Fabrication._newBoxId(), size, kind: null, fillL: 0, sealed: false, compostHours: 0, module: null };
    }

    // ── Box lifecycle ───────────────────────────────────────────────────────

    // Standard: 'empty' → 'food', or 'empty' → 'filling' → 'composting' → 'ready'.
    // Machine:  'empty' ↔ 'stored'.
    boxStatus(box) {
        if (this.isMachineBox(box)) return box.module ? 'stored' : 'empty';
        if (!box.kind) return 'empty';
        if (box.kind === 'food') return 'food';
        if (!box.sealed) return 'filling';
        return box.compostHours >= this.COMPOST_HOURS ? 'ready' : 'composting';
    }

    boxMassKg(box) {
        if (this.isMachineBox(box)) {
            return this.MACHINE_BOX.emptyMassKg + (box.module ? this.moduleMassKg(box.module) : 0);
        }
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
        this._cargo().items.compostingAgent -= 1;
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
        if (!this._canTrade()) return 'You have to be on a planet, with the local network in range, to sell';
        return null;
    }

    // Sells the compost; the box goes back to empty and unassigned.
    sell(boxId) {
        if (this.sellBlocker(boxId)) return 0;
        const box = this._box(boxId);
        const price = this.salePrice(box);
        this.game.credits += price;
        this._clearBox(box);
        return price;
    }

    _clearBox(box) {
        box.kind = null;
        box.fillL = 0;
        box.sealed = false;
        box.compostHours = 0;
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
        if (!this._canTrade()) return 'You have to be on the planet to buy';
        if (this.game.credits < this.FOOD.price) return 'Not enough credits';
        if (this.foodRoom() < this.FOOD.caseSize - 1e-9) {
            return 'No storage box with room for food — fabricate a storage box, or empty one';
        }
        // A box takes the same room full or empty, so only the mass is new.
        return this.spaceBlocker(this.FOOD.caseSize * this.FOOD.massKgPerRation, 0);
    }

    buyFood() {
        if (this.buyFoodBlocker()) return false;
        this.game.credits -= this.FOOD.price;
        this._storeRations(this.FOOD.caseSize);
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
        if (!this._canTrade()) return 'You have to be on the planet to buy';
        if (this.game.credits < item.price) return 'Not enough credits';
        return this.spaceBlocker(item.massKg, item.volumeM3);
    }

    buy(itemKey) {
        if (this.buyBlocker(itemKey)) return false;
        this.game.credits -= this.ITEMS[itemKey].price;
        this._cargo().items[itemKey] = this.count(itemKey) + 1;
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
        const value = this.MODULE_SELL_MIN + pct * (this.MODULE_SELL_MAX - this.MODULE_SELL_MIN);
        return Math.round(value * (module.juryRigged ? this.MODULE_JURY_RIG_VALUE : 1) * factor);
    }

    sellModuleBlocker(boxId) {
        const box = this._box(boxId);
        if (!box || !box.module) return 'Nothing stored';
        if (!this._canTrade()) return 'You have to be on a planet, with the local network in range, to sell';
        return null;
    }

    // Sells the stored module (any repair queued on it goes with it).
    sellModule(boxId) {
        if (this.sellModuleBlocker(boxId)) return 0;
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

    _recipeBox(recipe) {
        return recipe.size === 'machine'
            ? { massKg: this.MACHINE_BOX.emptyMassKg, volumeM3: this.MACHINE_BOX.volumeM3 }
            : { massKg: this.BOX.emptyMassKg,         volumeM3: this.BOX.volumeM3 };
    }

    // Queued jobs already hold their components; the box they'll make is
    // counted against ship space from the moment it's queued.
    queuedJobs() {
        return (this.game.repairQueue || []).filter(t => t.kind === 'fabricate');
    }

    fabricateBlocker(recipeKey) {
        const recipe = this.RECIPES[recipeKey];
        if (!recipe) return 'Unknown recipe';
        if (this.count('basicComponents') < recipe.components) {
            return `Needs ${recipe.components} basic component${recipe.components === 1 ? '' : 's'} — buy them on the market`;
        }
        // The components leave the hold and a box takes their place.
        const comp = this.ITEMS.basicComponents;
        const box  = this._recipeBox(recipe);
        return this.spaceBlocker(
            box.massKg   - comp.massKg * recipe.components,
            box.volumeM3 - comp.volumeM3 * recipe.components);
    }

    queueFabrication(recipeKey) {
        if (this.fabricateBlocker(recipeKey)) return null;
        const recipe = this.RECIPES[recipeKey];
        this._cargo().items.basicComponents -= recipe.components;
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
        if (recipe) this._cargo().items.basicComponents = this.count('basicComponents') + recipe.components;
    }

    completeTask(task) {
        const recipe = this.RECIPES[task.recipeKey];
        if (recipe) this.boxes().push(this._emptyBox(recipe.size));
        task.status = 'done';
    }

    // ── Ship capacity rows ──────────────────────────────────────────────────

    capacityItems() {
        const rows = [];
        Object.entries(this.ITEMS).forEach(([key, item]) => {
            const n = this.count(key);
            if (n > 0) rows.push({ label: item.name, count: n, massKg: item.massKg * n, volumeM3: item.volumeM3 * n });
        });
        this.boxes().forEach(box => {
            const what = box.kind === 'food' ? ' (food)'
                : box.module ? ` (${this.moduleName(box.module.moduleKey)})` : '';
            rows.push({ label: this.boxLabel(box) + what, count: 1, massKg: this.boxMassKg(box), volumeM3: this.boxVolumeM3(box) });
        });
        Object.entries(this.RECIPES).forEach(([key, recipe]) => {
            const pending = this.queuedJobs().filter(t => t.recipeKey === key).length;
            if (!pending) return;
            const box = this._recipeBox(recipe);
            rows.push({ label: `${recipe.name} (being made)`, count: pending, massKg: box.massKg * pending, volumeM3: box.volumeM3 * pending });
        });
        return rows;
    }
}
