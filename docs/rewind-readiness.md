# Rewind

**Status:** built. The Timeline (`timeline.js`, opened from the pause menu)
takes the checkpoints and goes back to them. The tree is kept by `db.js`
(`save_checkpoints`). This file records how it works and the rules that keep
new work compatible with it.

## How it works

The player can go back to an earlier point in a game and try something else,
then later return to **any** point on **any** line they've played. Nothing is
thrown away by going back.

- **Checkpoints form a tree.** Each checkpoint stores its parent. Going back to
  checkpoint C and playing on adds new checkpoints under C. The line you left is
  still there, so every branch can be reached again.
- **Leaving a line saves where it ended.** Before going back, the live state is
  saved as a checkpoint, so the end of the line you're leaving can be reached
  again too.
- **Checkpoints follow game time, not real time.** Autosave runs every 5 real
  minutes. That's 5 game minutes at 1× but about 58 game days at 1000×, so it
  can't give you "go back 2 hours". Checkpoints are taken when `gameTime`
  crosses a game hour instead. On the current line, every hourly checkpoint
  from the most recent game day is kept, and older days are thinned to one
  each. The start, manual saves, branch ends and the points where lines split
  are always kept. New Game and Save Game add checkpoints too; autosave
  doesn't.
- **A save made before checkpoints existed** gets its first checkpoint when
  it's loaded.

### Storage

One table holding the same payload a normal save already sends:

```
save_checkpoints(id, save_id, parent_id, game_time, created_at, kind, credits, crew_count, payload JSON)
saves.head_checkpoint_id  -- the checkpoint the live state grew from
```

Kinds: `start` (New Game), `hourly`, `save` (Save Game), `branch-end` (the
state left behind when going back). API: `GET`/`POST /api/saves/:id/checkpoints`
and `POST /api/saves/:id/checkpoints/:cid/restore`.

The existing normalised tables (`saves`, `ships`, `ship_modules`, …) stay the
live state. A checkpoint is a JSON snapshot of `{world, shipInstances}` next
to them. Going back is one server transaction (`db.restoreCheckpoint`): store the
live state as a `branch-end`, write the checkpoint's payload as the live save,
and make the checkpoint the head. The client then applies it with
`GameState.restore` and `game.afterRewind()`. A payload is a few KB, so
hundreds per save are fine. Don't add a version column to every existing table.
Deleting a save must delete its checkpoints too (`db.deleteSave`).

## Rules for all new work

1. **All game state goes through the snapshot.** Anything that changes how the
   game plays must be written by `GameState.snapshot` /
   `GameState.shipInstanceSnapshot` and read back by `GameState.restore`. State
   kept only on `StarshipGame` (or another class) won't be restored when the
   player goes back. Per-browser UI preferences in `localStorage` (tips seen,
   tour, sound levels) are not game state and stay out of the snapshot.

2. **`restore` must keep loading old payloads.** A checkpoint made today may be
   restored after several later migrations. Give every newly read field a
   default (`?? …`) for payloads that don't have it. If a field's *meaning*
   changes, add an upgrade step keyed on `world.version`. Don't assume the
   payload matches the current shape.

3. **Every gameplay roll uses `game.rng.next()`, never `Math.random()`.**
   `GameRng` (`rng.js`) is a seeded mulberry32 stream. New games seed it from
   the sector seed (`GameRng.fromSeed`), and its state is saved as `world.rng.state`
   (`saves.rng_state`). Restoring a save or checkpoint therefore replays the same
   rolls. `tests/rng.spec.js` fails if gameplay calls `Math.random()`. These are
   allowed to use `Math.random()`: picking a new seed (`CommsNav.rollSeed`),
   sound synthesis, and ids that don't affect play. Prefer ids that don't
   consume a roll (see repair task ids and sector location ids), because an
   extra roll shifts every roll after it.

4. **Static reference data is not part of a checkpoint.** `module_specs.json`,
   `ship_classes.json`, `crew_manifest.json` and `story_messages.json` are read
   live. A rewound game uses whatever tuning is current. That's intended: if
   the tuning changes, old saves pick it up.

## How deterministic it is

The same seed and the same actions at the same game times give the same game.
It can differ when:

- **The game speed is different.** Each tick advances `gameSpeed` game-seconds
  and rolls once per tick per chance (for example one infection roll per crew
  member per tick, scaled to the tick's length). Playing a stretch at 10×
  instead of 1000× uses a different number of rolls, so later rolls come out
  differently. The odds over time are the same; the exact results are not.
- **Player actions happen at different game times.** Any action between ticks
  changes the inputs to the next tick.

That's enough for "go back and try something else". It isn't frame-perfect
replay, and doesn't need to be.
