# AI Simulation Report — Stratcon
Generated: 2026-07-21T23:46:36.488Z
Map: 20×20 | Games: 10 | AI: runAILevel3 (P1) vs runAILevel3 (P2)

## Win Rates
| Player | Wins | Win Rate |
|--------|------|----------|
| Player 1 (top-left quadrant) | 0 | 0% |
| Player 2 (bottom-right quadrant) | 0 | 0% |
| Draws (timeout at 300 turns) | 10 | 100% |

## Game Length
- Average: **151.0 turns**
- Min: 151 turns
- Max: 151 turns

## First Contact
- Average turn of first contact: **12.3**
- Games with contact before turn 10: 1/10

## Combat Statistics
- Average attacks per turn: **3.10**
- Average P1 units lost: 101.5
- Average P2 units lost: 95.6

## City Capture
- Average turn of first city captured: 4.4
- Average cities captured by P1: 3.1
- Average cities captured by P2: 4.3
- Average P1 cities at game end: 4.0
- Average P2 cities at game end: 5.3

## Attack Activity by Turn Range
- Turns 5–9: 8 attacks total across all games
- Turns 10–14: 82 attacks total across all games
- Turns 15–19: 164 attacks total across all games
- Turns 20–24: 169 attacks total across all games
- Turns 25–29: 170 attacks total across all games
- Turns 30–34: 169 attacks total across all games
- Turns 35–39: 170 attacks total across all games
- Turns 40–44: 177 attacks total across all games
- Turns 45–49: 175 attacks total across all games
- Turns 50–54: 166 attacks total across all games
- Turns 55–59: 171 attacks total across all games
- Turns 60–64: 173 attacks total across all games

## Identified Bottlenecks
- ⚠️  Slow exploration: First contact at turn 12.3 — AI takes 12 turns before armies meet
- ⚠️  Prolonged games: Avg 151 turns — AI lacks closing instinct, games drag on
- ⚠️  Late engagement: Combat peaks only at turns 125-129 — early turns wasted

## Recommendations (Tuning Weights in runAILevel3)

### [1] [HIGH] Slow opening exploration
**Problem:** Increase exploration bonus weight from score 2 → 15. Add a "blitz phase" flag for turns 1-5 where units skip production-city-hunting and beeline toward center of map instead.

```js
// In exploration fallback, change:
if (step) { bestScore = 2; ... }
// to:
const turnBonus = Math.max(0, 10 - state.turn);
if (step) { bestScore = 15 + turnBonus; ... }
```

### [2] [MEDIUM] Games drag on without decisive action
**Problem:** Add a "siege mode" after turn 20: if AI owns >50% of cities and there are known enemy cities, skip neutral expansion and mass all units toward closest enemy city. Also: stack tanks as primary production (not army) to create faster-moving assault groups.

```js
// Add before production decision:
const ownedCities = friendlyCities.length;
const totalKnownCities = friendlyCities.length + neutralCities.length + enemyCities.length;
const siegeMode = state.turn > 20 && ownedCities > totalKnownCities * 0.5;
if (siegeMode) { prod = 'tank'; /* force tanks for fast push */ }
```

### [3] [LOW] Production decisions are reactive not strategic
**Problem:** Pre-compute "needed unit mix" at game start: 60% army (cap), 30% tank (speed+attack), 10% other. Always keep this ratio. Remove "coastal destroyer" early priority — on a 20x20 map, sea units are rarely decisive before game ends.

```js
// Replace production logic with:
const armyRatio = (aiCounts['army']||0) / Math.max(1, totalAI);
const tankRatio  = (aiCounts['tank'] ||0) / Math.max(1, totalAI);
if (armyRatio < 0.6) prod = 'army';
else if (tankRatio < 0.3) prod = 'tank';
else prod = 'army';
```

### [4] [LOW] BFS path scoring ignores turn cost
**Problem:** aiBFS finds shortest path by hops but units have variable move speeds (army=1, tank=2). Weight paths by actual turns needed: dist/unit.movesLeft. This avoids slow armies wasting turns on long routes when a tank could arrive faster.

```js
// Add turn-cost to score:
const turnsToReach = Math.ceil(d / (def.move || 1));
if (type === 'capture_enemy')  return 80 - turnsToReach * 3;
if (type === 'capture_neutral') return 90 - turnsToReach * 2;
```


## Per-Game Results
| Game | Winner | Turns | First Contact | Attacks/Turn | P1 Lost | P2 Lost |
|------|--------|-------|---------------|--------------|---------|---------|
| 1 | Draw | 151 | never | 0 | 0 | 0 |
| 2 | Draw | 151 | 7 | 7.2 | 238 | 225 |
| 3 | Draw | 151 | 12 | 3.6 | 123 | 120 |
| 4 | Draw | 151 | never | 0 | 0 | 0 |
| 5 | Draw | 151 | never | 0 | 0 | 0 |
| 6 | Draw | 151 | 13 | 7.6 | 256 | 231 |
| 7 | Draw | 151 | 15 | 3.4 | 108 | 103 |
| 8 | Draw | 151 | 12 | 5.7 | 177 | 170 |
| 9 | Draw | 151 | never | 0 | 0 | 0 |
| 10 | Draw | 151 | 15 | 3.5 | 113 | 107 |
