# Stratcon Code Optimization Report

**Date:** 2026-07-20  
**Files audited:** `server.js`, `public/index.html`

---

## Summary

| File | Before | After | Lines Removed |
|------|--------|-------|---------------|
| `server.js` | 2067 | 1779 | **288** |
| `public/index.html` | 2656 | 2630 | **26** |
| **Total** | **4723** | **4409** | **314** |

---

## server.js Changes

### 1. Removed dead `runAI` function (~315 lines → 0)

`runAI` (the original Level 1/2 AI) was never called. `scheduleAI` was already exclusively calling `runAILevel3`. The function body (~315 lines, lines 1198–1512 in the original) was entirely dead code. **Removed.**

### 2. Extracted shared `finishAITurn(state)` helper (~27 lines added, saves ~55 lines)

The AI turn wrap-up logic was copy-pasted identically in both `runAILevel3` and `runAI`:
- Reset `activePlayer`, `turnEnded`, `aiPending`
- Restore player 1's `movesLeft`
- Run the production tick (iterate all cities, progress production)
- Call `checkWin` and `broadcastToPlayer`

Extracted into a single `finishAITurn(state)` function. `runAILevel3` now ends with:
```js
  // ── Wrap up AI turn ──
  finishAITurn(state);
}
```

**Note:** The inline production tick in `runAILevel3`'s wrap-up was missing the **fuel crash check** that `advanceTurn` runs on turn end. `finishAITurn` intentionally does NOT include the fuel check because: (a) `advanceTurn` handles player turns and (b) the AI turn is considered ended before the player's view — no fuel should crash mid-AI-move. This preserves existing behavior.

### 3. Added game cleanup via `scheduleGameCleanup(state)` (~10 lines)

The `games` Map was never cleaned up — every completed game stayed in memory forever. Added:

```js
function scheduleGameCleanup(state) {
  // Remove ended games from memory after 5 minutes
  setTimeout(() => {
    if (state.phase === 'ended') {
      games.delete(state.roomCode);
      console.log('Game cleaned up:', state.roomCode);
    }
  }, 5 * 60 * 1000);
}
```

`checkWin` now calls `scheduleGameCleanup(state)` when either player wins. The 5-minute delay allows late-connecting clients to still get the final state.

---

## public/index.html Changes

### 1. Removed `drawIconHelicopter` function (14 lines)

The `helicopter` unit type doesn't exist in the game (not in `UNIT_DEFS`). The icon drawing function and its dispatch case in `drawIconByType` were dead code. **Removed both.**

### 2. Removed `hexNeighborsList` duplicate function (11 lines)

`hexNeighborsList(col, row)` was byte-for-byte identical to `hexNeighbors(col, row)` — same logic, same return shape `{x, y}`. **Removed** `hexNeighborsList` and replaced 2 call sites with `hexNeighbors`.

### 3. Removed duplicate `touch-action: none` in `#map-canvas` CSS (1 line)

`#map-canvas` had `touch-action: none` declared twice consecutively. Removed the duplicate.

### 4. Removed `helicopter` from data tables (2 entries)

- Removed `helicopter:6` from `unitCost` table in render loop
- Removed `helicopter:'air'` from `getDomain` lookup table

These were dead data entries — no helicopter unit can exist in game state.

### 5. Removed "🚁Helicopter" from how-to-play UI text (1 line)

The how-to-play card listed 🚁Helicopter as a unit type, which is misleading since it doesn't exist in the game.

---

## Issues Found But Not Fixed

### server.js

1. **`getUnitsOnTile` (line ~217)** — Only used by `getTileUnitCount`. Could be inlined to a one-liner, but it's clean and harmless as-is.

2. **`getPathStep` (line ~1273)** — Greedy nearest-neighbor pathfinding used for multi-step player moves. Less accurate than `aiBFS` (BFS). Not a bug, but player multi-step movement uses a different algorithm than AI movement. Inconsistency worth noting. *No fix — behavior change risk.*

3. **`advanceTurn` production tick is still duplicated** — `advanceTurn` runs its own production tick inline (not via `finishAITurn`). Consolidating these would require refactoring `advanceTurn` to call `finishAITurn` or vice versa, but they handle slightly different cases (different `nextPlayer` logic, turn timer setup). *Deferred — would require careful merge.*

4. **`countCities` function (line ~584)** — Iterates all tiles every call. Called inside `checkWin` which is called after every move. On 40×40 maps = 1600 iterations × 2 calls per `checkWin` = 3200 iterations per move. Acceptable for this scale, but could be cached. *Not fixed — premature optimization.*

5. **No turn timer cleanup when both players disconnect** — If both players disconnect during a game, the turn timer keeps firing. The timer calls `advanceTurn` → `broadcastState`, which sends to null sockets (harmless), but the game stays alive in memory forever. `scheduleGameCleanup` only triggers on win, not disconnect. *Partial fix in place (cleanup on win) — full fix would need disconnect-count tracking.*

### public/index.html

6. **`render()` called directly in many event handlers (lines 2488, 2495, 2522, etc.)** — After the drag fix, the pattern is mostly correct (drag uses `schedulePanRender`), but tap/click handlers still call `render()` directly. These are user-initiated discrete events (not continuous), so this is acceptable — direct `render()` is fine for click responses. *No fix needed.*

7. **`requestAnimationFrame(render)` in `drawMoveRange` (line ~2023)** — Inside the render function itself, `drawMoveRange` schedules another `requestAnimationFrame(render)` to animate the pulse effect. This creates a continuous loop whenever a unit is selected that bypasses the `_animNeeded` throttle in `startAnimLoop`. The anim loop's idle optimization is effectively defeated when a unit is selected. *Low priority, works correctly — skip.*

8. **`startCountdown` setInterval never cleared on game end (line ~2328)** — The countdown timer for turn time limit starts but isn't explicitly stopped when the game ends. Since `TURN_SECONDS = 99999` (effectively disabled), this is dormant. *Not fixed.*

9. **CSS: `#map-canvas` has redundant `display: block` (line ~210)** — `<canvas>` is already block-level in modern browsers. Harmless.

---

## Structural Recommendations

1. **Extract production tick into its own server function** — `advanceTurn` and `finishAITurn` both run identical production logic. A shared `runProductionTick(state)` would eliminate this last duplication.

2. **Move AI helpers to a separate file** — `runAILevel3`, `aiBFS`, `onSameLandmass`, `findNearestCoastalLand`, `finishAITurn`, and the scheduling logic could live in `ai.js`, keeping `server.js` focused on networking and game state.

3. **Split index.html** — At 2630 lines, the single file mixes HTML, CSS, and JS. Splitting into `style.css` and `game.js` would aid maintainability.

4. **Consider caching fog-of-war** — `getVisibleTiles` does BFS from every unit and city on every `buildClientState` call. On large maps with many units this runs on every broadcast. A dirty flag on unit moves would allow caching.
