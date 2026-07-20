# StratCon Playtest Report

**Date:** 2026-07-19  
**Playtester:** Automated AI vs AI (socket.io client, 3 games @ 50 turns each)  
**Map size:** small (20×20)  
**Games completed:** 3 / 3  

---

## Executive Summary

Three 50-turn automated games were run back-to-back. **No game reached a win condition.** The turn-flip mechanism works correctly, but two serious bugs prevent the game from ever ending: (1) production is uncapped and cities continue spawning units even when surrounded hexes are completely full, causing exponential unit accumulation and hundreds of `moveError: Hex is full` responses per game; and (2) in all three games the two armies never met in combat — the neutral cities were too far away (or inaccessible) for the randomly-moving AI, meaning the win condition (`p2Cities === 0 && p2Units === 0`) was never satisfied.

---

## Game-by-Game Results

| Game | Turns | Winner | Move Errors | Turn-Flip Bugs | Stuck Bugs |
|------|-------|--------|-------------|----------------|------------|
| 1    | 50    | None   | 6           | 0              | 0          |
| 2    | 50    | None   | 367         | 0              | 0          |
| 3    | 50    | None   | 496         | 0              | 0          |

**Total `moveError: Hex is full` events across all games:** 869+ (1,738 lines in log)

---

## Bugs Found

### BUG 1 — Critical: Cities produce indefinitely even when all surrounding hexes are full

**Severity:** High  
**First seen:** Game 2, Turn 4 (P1 already had 4 units jammed together); Game 1, Turn 38  

**What happens:**  
`advanceTurn()` increments `city.progress` and calls `spawnUnit()` every time `progress >= buildTime`, even when all 6 neighboring hexes are at the 2-unit stacking limit. `spawnUnit()` has a guard (`if (count >= 2) return null`) but it only checks the *city hex itself* — not whether there is anywhere to spread. If the city hex has < 2 units the spawn succeeds; if it has 2 it is silently dropped, but the production counter resets to 0 and tries again next turn.

The compound effect: units pile on to a few accessible hexes, fill them, and subsequent moves all return `Hex is full`. By turn 50 of Game 2, P1 had **62 units** crammed into a small island.

**Log evidence:**
```
Turn 21 | P1 | Cities: P1=2 P2=0 | Units: P1=22 P2=0
ERROR: P1 moveError @ turn 21: Hex is full  (×9 in same turn)

Turn 50 | P1 | Cities: P1=4 P2=0 | Units: P1=62 P2=4
```

**Recommended fix:**  
Before spawning a unit, verify at least one adjacent land hex (or the city hex itself) is not full:
```js
function spawnUnit(state, owner, type, x, y) {
  // ... existing void/stacking check on city hex ...
  // NEW: also check there is somewhere for the unit to go
  const def = UNIT_DEFS[type];
  const freeTiles = hexNeighbors(x, y, state.mapW, state.mapH).filter(n => {
    const t = state.tiles[n.y][n.x];
    return t && t.type !== 'void' && getTileUnitCount(state, n.x, n.y) < 2;
  });
  const cityFull = getTileUnitCount(state, x, y) >= 2;
  if (cityFull && freeTiles.length === 0) return null; // don't spawn into a dead end
  ...
}
```
Alternatively: pause production (`city.progress` does not advance) when the city hex is already at the stacking limit.

---

### BUG 2 — Major: Game never ends — armies never make contact; win condition never triggers

**Severity:** High  
**All 3 games affected**

**What happens:**  
On a small (20×20) map, the two starting cities are placed in opposing quadrants. The initial army units move randomly with only 1 move per turn. The hex stacking limit quickly traps most units on their home island before they can ever reach enemy territory. In 150 total turns across 3 games:

- P1 captured some *neutral* cities (P1's city count went from 1 → 2, 3, even 4 in some games)  
- P2 captured some neutral cities  
- **The two forces never met in direct combat** — not a single unit-kills-unit event was observed between P1 and P2 armies  
- The `checkWin` condition (`p2Cities===0 && p2Units===0`) was never triggered

**Root causes:**
1. The random-move AI picks any valid neighbor hex regardless of direction — it does not approach the enemy.
2. Land units cannot cross ocean, so if players are on separate landmasses with no land bridge, there is no path. The fog-of-war means each player's client can only see their own territory; the AI (client-side) cannot see the enemy city to navigate toward it.
3. The `"Hex is full"` flooding (Bug 1) makes it impossible to push units off the home island before production swamps all available hexes.

**Note:** The server's *built-in* AI (for `vsComputer` mode) uses `findNearestCity()` with a path-step algorithm and *does* seek enemy cities — but that code only runs in solo (vs-computer) mode and is never exercised in 2-player mode. There is no equivalent server-side guidance for 2-player AI clients.

**Recommended fix:**  
The server-side win condition is correct. The underlying problem is that without a smart AI or land connectivity, the game cannot end. Suggested improvements:
1. Ensure the map generator always places both starting cities on the same landmass or with a guaranteed land bridge — check `hexDistance` is reachable by land.
2. Or: expose a server-side 2-player AI mode so the server drives both players intelligently (similar to `vsComputer`).
3. Or: document that the game requires human players to complete.

---

### BUG 3 — Moderate: `moveError: Hex is full` has no cooldown / the client is never told to stop trying

**Severity:** Medium  
**Games 2 and 3 most affected**

**What happens:**  
When the AI sends `moveUnit` and receives `moveError: Hex is full`, it has no way to know the destination is permanently blocked — it will keep trying the same blocked neighbors on every turn. This creates a feedback storm: in the worst turns (Game 2, turn 30+) the server was responding to 13+ `moveError` events per half-turn.

**Log evidence:**
```
Turn 30 | P1 | Cities: P1=2 P2=0 | Units: P1=30 P2=0
ERROR: P1 moveError @ turn 30: Hex is full  (×13 in the same turn)
```

**Recommended fix:**  
The server already correctly rejects the move and returns `moveError`. The fix is in the client/AI: after receiving `moveError`, filter that destination out of the valid-neighbor list for the remainder of the turn. The server could also help by including `{ reason: 'full', x, y }` in the `moveError` payload so the client can cache blocked hexes.

---

### BUG 4 — Minor: Fog of War causes misleading city counts

**Severity:** Low / cosmetic  
**All games**

**What happens:**  
Each player's client state only shows cities within their visible fog. When P1's units have never explored P2's quadrant, P1 sees `Cities P2=0` even though P2 owns a city. This is correct behavior per the server design, but it means:
- A player could appear to be winning (enemy cities = 0) when they are not
- The win condition on the *server* is computed from the authoritative state (not the client view), so the game result is correct; only the display is misleading

**Recommended fix:**  
Cosmetic only — UI could show "P2 cities: unknown" or "?" when outside visible range.

---

## What Worked Correctly

| Mechanic | Status |
|----------|--------|
| Game creation (`createGame`) | ✅ Working |
| Game joining (`joinGame`) | ✅ Working |
| Turn alternation (P1 → P2 → P1…) | ✅ Working — 0 turn-flip bugs across 150 turns |
| `stateUpdate` broadcast to both players | ✅ Working |
| Unit movement (valid moves) | ✅ Working |
| Move rejection for invalid destinations (wrong domain, void, too far) | ✅ Working |
| `Hex is full` stacking limit enforcement | ✅ Working (though units still spawn faster than they can escape) |
| Production system (`setProduction` + `progress` counter) | ✅ Working — units were built and appeared as expected |
| Neutral city capture by land unit | ✅ Working — P1 went from 1 → 2, 3, 4 cities over multiple games |
| Unit consumed on capture (`state.units.filter`) | ✅ Working (unit disappears, city owner changes) |
| `endTurn` advances active player | ✅ Working |
| Movement point reset on new turn | ✅ Working |

---

## Recommended Priority Fixes

1. **[Critical]** Fix `spawnUnit` to not spawn when all city-adjacent hexes are full — or pause production progress when blocked. This alone would prevent the 869-error flood and unit pile-up.

2. **[High]** Ensure map generation places both starting cities on the same connected landmass (or add a land bridge guarantee). Without this, 2-player games on small maps can degenerate into two isolated production loops with no interaction.

3. **[Medium]** Add `{ x, y }` coordinates to `moveError` payload so clients can cache blocked hexes and stop re-trying them each turn.

4. **[Low]** UI or state: show `"?"` for unvisited enemy city count rather than `0` to avoid player confusion.

---

## Raw Log

Full turn-by-turn output saved to `/tmp/playtest.log`.  
Key statistics:
- Game 1: 50 turns, 6 `moveError` events, P1 ended with 16 units / 2 cities
- Game 2: 50 turns, 367 `moveError` events, P1 ended with 62 units / 4 cities  
- Game 3: 50 turns, 496 `moveError` events, P1 ended with 6 units / 1 city (tight map, max stacking hit early)
