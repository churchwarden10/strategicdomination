/**
 * ai-sim-v2.js — Stratcon AI vs AI simulation (v2)
 * Changes from base:
 *  - HP regen: 20% of maxHp per turn (not 33%)
 *  - Win condition: 80% of cities for 5 consecutive turns = dominance win
 *  - Annihilation win still works
 *  - Per-game stats: winner, win reason, turn count, cities held, attacks per side, first contact turn
 */

'use strict';

const NUM_GAMES = 5;
const MAX_TURNS = 300;

// ── Unit stats ─────────────────────────────────────────────────────────────
const UNIT_DEFS = {
  army:       { buildTime: 1,  move: 1,  domain: 'land', fuel: null, carries: null,      canCapture: true,  symbol: '🪖', slots: 1,  maxHp: 3  },
  tank:       { buildTime: 2,  move: 2,  domain: 'land', fuel: null, carries: null,      canCapture: true,  symbol: '🛡️', slots: 2,  maxHp: 6  },
  fighter:    { buildTime: 4,  move: 10, domain: 'air',  fuel: 10,   carries: null,      canCapture: false, symbol: '✈️', slots: 0,  maxHp: 6  },
  bomber:     { buildTime: 5,  move: 15, domain: 'air',  fuel: 15,   carries: null,      canCapture: false, symbol: '💣', slots: 0,  maxHp: 8  },
  submarine:  { buildTime: 4,  move: 4,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, symbol: '🤿', hidden: true, slots: 0, maxHp: 4 },
  destroyer:  { buildTime: 4,  move: 4,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, symbol: '🚢', slots: 0,  maxHp: 5  },
  transport:  { buildTime: 3,  move: 3,  domain: 'sea',  fuel: null, carries: 'army',    canCapture: false, capacity: 3, symbol: '⛴️', slots: 0, maxHp: 10 },
  carrier:    { buildTime: 8,  move: 3,  domain: 'sea',  fuel: null, carries: 'fighter', canCapture: false, capacity: 8, symbol: '🛳️', slots: 0, maxHp: 10 },
  battleship: { buildTime: 8,  move: 3,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, symbol: '⚓', slots: 0,  maxHp: 10 },
};

// ── Hex helpers ────────────────────────────────────────────────────────────
const HEX_NEIGHBORS_EVEN = [[1,0],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1]];
const HEX_NEIGHBORS_ODD  = [[1,0],[1,-1],[0,-1],[-1,0],[0,1],[1,1]];

function hexNeighbors(col, row, mapW, mapH) {
  const dirs = (row % 2 === 0) ? HEX_NEIGHBORS_EVEN : HEX_NEIGHBORS_ODD;
  const result = [];
  for (const [dc, dr] of dirs) {
    const nc = col + dc, nr = row + dr;
    if (nc >= 0 && nc < mapW && nr >= 0 && nr < mapH) result.push({ x: nc, y: nr });
  }
  return result;
}

function hexDistance(c1, r1, c2, r2) {
  function offsetToCube(col, row) {
    const x = col - (row - (row & 1)) / 2;
    const z = row;
    return { x, y: -x - z, z };
  }
  const a = offsetToCube(c1, r1);
  const b = offsetToCube(c2, r2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

function offsetToCube(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return { x, y: -x - z, z };
}

function isInHexBounds(col, row, mapW, mapH) {
  const radius = Math.floor(mapW / 2);
  const a = offsetToCube(col, row);
  const b = offsetToCube(mapW / 2, mapH / 2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= radius;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Map Generation ─────────────────────────────────────────────────────────
function generateMap(mapW, mapH) {
  const noise = [];
  for (let i = 0; i < mapW * mapH; i++) noise.push(Math.random());

  function idx(x, y) { return y * mapW + x; }
  const smoothed = noise.slice();
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < mapH; y++) {
      for (let x = 0; x < mapW; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x+dx, ny = y+dy;
            if (nx >= 0 && nx < mapW && ny >= 0 && ny < mapH) { sum += smoothed[idx(nx,ny)]; count++; }
          }
        }
        smoothed[idx(x,y)] = sum / count;
      }
    }
  }

  const inBoundValues = [];
  for (let y = 0; y < mapH; y++)
    for (let x = 0; x < mapW; x++)
      if (isInHexBounds(x, y, mapW, mapH)) inBoundValues.push(smoothed[idx(x,y)]);

  const sorted = inBoundValues.slice().sort((a,b)=>a-b);
  const threshold = sorted[Math.floor(sorted.length * 0.52)];

  const tiles = [];
  for (let y = 0; y < mapH; y++) {
    tiles.push([]);
    for (let x = 0; x < mapW; x++) {
      if (!isInHexBounds(x, y, mapW, mapH)) {
        tiles[y].push({ type: 'void', owner: null, city: null });
        continue;
      }
      tiles[y].push({ type: smoothed[idx(x,y)] >= threshold ? 'land' : 'ocean', owner: null, city: null });
    }
  }

  function isCoastal(x, y) {
    for (const nb of hexNeighbors(x, y, mapW, mapH))
      if (tiles[nb.y][nb.x].type === 'ocean') return true;
    return false;
  }

  const visited = new Set();
  const landmasses = [];
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      if (tiles[y][x].type !== 'ocean' && tiles[y][x].type !== 'void' && !visited.has(y*mapW+x)) {
        const mass = [];
        const queue = [[x,y]];
        while (queue.length) {
          const [cx,cy] = queue.shift();
          const k = cy*mapW+cx;
          if (visited.has(k)) continue;
          visited.add(k); mass.push([cx,cy]);
          for (const nb of hexNeighbors(cx,cy,mapW,mapH)) {
            const nt = tiles[nb.y][nb.x];
            if (!visited.has(nb.y*mapW+nb.x) && nt.type !== 'ocean' && nt.type !== 'void')
              queue.push([nb.x, nb.y]);
          }
        }
        landmasses.push(mass);
      }
    }
  }

  const cities = [];
  const minDist = 4;
  const maxCityDist = 10;

  function placeCity(cx, cy) {
    cities.push([cx, cy]);
    tiles[cy][cx].type = 'city';
    tiles[cy][cx].city = { owner: null, production: null, progress: 0, id: cities.length-1, coastal: isCoastal(cx,cy) };
  }

  function tryPlaceCity(candidates) {
    shuffle(candidates);
    for (const [cx, cy] of candidates) {
      let tooClose = false;
      for (const [ex,ey] of cities)
        if (hexDistance(cx,cy,ex,ey) < minDist) { tooClose = true; break; }
      if (!tooClose) { placeCity(cx,cy); return true; }
    }
    return false;
  }

  for (const mass of landmasses) {
    if (mass.length < 2) continue;
    const coastal = mass.filter(([x,y]) => isCoastal(x,y));
    const inland  = mass.filter(([x,y]) => !isCoastal(x,y));
    tryPlaceCity(coastal);
    const remaining = [...coastal, ...inland];
    const slotsForMass = Math.max(0, Math.floor(mass.length / 8));
    for (let i = 0; i < slotsForMass; i++) tryPlaceCity(remaining);
  }

  const allLandTiles = [];
  for (let y = 0; y < mapH; y++)
    for (let x = 0; x < mapW; x++)
      if (tiles[y][x].type === 'land') allLandTiles.push([x,y]);
  shuffle(allLandTiles);
  for (const [lx,ly] of allLandTiles) {
    const nearCity = cities.some(([cx,cy]) => hexDistance(lx,ly,cx,cy) <= maxCityDist);
    if (!nearCity) {
      let tooClose = false;
      for (const [ex,ey] of cities)
        if (hexDistance(lx,ly,ex,ey) < minDist) { tooClose = true; break; }
      if (!tooClose) placeCity(lx,ly);
    }
  }

  for (const [cx,cy] of cities)
    if (tiles[cy][cx].city) tiles[cy][cx].city.coastal = isCoastal(cx,cy);

  let p1City = null, p2City = null;
  for (const [x,y] of cities) {
    if (!p1City && x < mapW/2 && y < mapH/2) p1City = [x,y];
    if (!p2City && x >= mapW/2 && y >= mapH/2) p2City = [x,y];
  }
  if (!p1City) p1City = cities[0];
  if (!p2City) p2City = cities[cities.length-1];

  return { tiles, cities, p1City, p2City };
}

// ── Unit stacking ──────────────────────────────────────────────────────────
function getTileUnitCount(state, x, y) {
  return state.units.filter(u => u.x === x && u.y === y).length;
}

let uidCounter = 0;
function newUid() { return ++uidCounter; }

function spawnUnit(state, owner, type, x, y) {
  if (getTileUnitCount(state, x, y) >= 2) return null;
  if (state.tiles[y] && state.tiles[y][x] && state.tiles[y][x].type === 'void') return null;
  const def = UNIT_DEFS[type];
  const unit = { id: newUid(), owner, type, x, y, movesLeft: def.move, fuel: def.fuel,
    hp: def.maxHp, maxHp: def.maxHp, cargo: [], symbol: def.symbol };
  state.units.push(unit);
  return unit;
}

// ── Fog of War ─────────────────────────────────────────────────────────────
function getVisibleTiles(state, playerNum) {
  const { mapW, mapH } = state;
  const visible = new Set();
  const range = 2;

  function reveal(cx, cy) {
    const queue = [[cx, cy, 0]];
    const seen = new Set([cy * mapW + cx]);
    visible.add(cy * mapW + cx);
    while (queue.length) {
      const [qx, qy, dist] = queue.shift();
      if (dist >= range) continue;
      for (const nb of hexNeighbors(qx, qy, mapW, mapH)) {
        if (state.tiles[nb.y][nb.x].type === 'void') continue;
        const k = nb.y * mapW + nb.x;
        if (!seen.has(k)) { seen.add(k); visible.add(k); queue.push([nb.x, nb.y, dist+1]); }
      }
    }
  }

  for (const unit of state.units)
    if (unit.owner === playerNum) reveal(unit.x, unit.y);
  for (let y = 0; y < mapH; y++)
    for (let x = 0; x < mapW; x++) {
      const t = state.tiles[y][x];
      if (t.type === 'city' && t.city && t.city.owner === playerNum) reveal(x, y);
    }

  if (state.exploredTiles && state.exploredTiles[playerNum])
    for (const k of visible) state.exploredTiles[playerNum].add(k);

  return visible;
}

// ── Combat ─────────────────────────────────────────────────────────────────
const UNIT_COMBAT = {
  army:       { attack: 2, defense: 2 },
  tank:       { attack: 3, defense: 3 },
  fighter:    { attack: 3, defense: 3 },
  bomber:     { attack: 4, defense: 2 },
  submarine:  { attack: 2, defense: 2 },
  destroyer:  { attack: 2, defense: 2 },
  transport:  { attack: 0, defense: 1 },
  carrier:    { attack: 1, defense: 2 },
  battleship: { attack: 4, defense: 4 },
};

function resolveCombat(state, attacker, defender, stats) {
  const atkStats = UNIT_COMBAT[attacker.type] || { attack: 1, defense: 1 };
  const defStats = UNIT_COMBAT[defender.type] || { attack: 1, defense: 1 };

  if (attacker.hp == null) { attacker.hp = UNIT_DEFS[attacker.type]?.maxHp || 3; attacker.maxHp = attacker.hp; }
  if (defender.hp == null) { defender.hp = UNIT_DEFS[defender.type]?.maxHp || 3; defender.maxHp = defender.hp; }

  let atkRoll, defRoll, atkDmg, defDmg, rolls = 0;
  do {
    atkRoll = Math.ceil(Math.random() * 6);
    defRoll = Math.ceil(Math.random() * 6);
    atkDmg = atkRoll <= atkStats.attack ? atkRoll : 0;
    defDmg = defRoll <= defStats.defense ? defRoll : 0;
    rolls++;
    if (rolls > 20) break;
  } while (atkDmg === 0 && defDmg === 0);

  if (atkDmg > 0) defender.hp = Math.max(0, defender.hp - atkDmg);
  if (defDmg > 0) attacker.hp = Math.max(0, attacker.hp - defDmg);

  const defenderDied = defender.hp <= 0;
  const attackerDied = attacker.hp <= 0;

  if (stats) {
    // Track attacks per side
    stats.attacksByPlayer[attacker.owner] = (stats.attacksByPlayer[attacker.owner] || 0) + 1;
    if (defenderDied) stats.unitsLost[defender.owner] = (stats.unitsLost[defender.owner] || 0) + 1;
    if (attackerDied) stats.unitsLost[attacker.owner] = (stats.unitsLost[attacker.owner] || 0) + 1;
  }

  if (attackerDied && defenderDied) {
    state.units = state.units.filter(u => u.id !== attacker.id && u.id !== defender.id);
    return null;
  } else if (defenderDied) {
    state.units = state.units.filter(u => u.id !== defender.id);
    return attacker;
  } else if (attackerDied) {
    state.units = state.units.filter(u => u.id !== attacker.id);
    return null;
  }
  return attacker;
}

// ── Movement domain check ──────────────────────────────────────────────────
function checkMoveDomain(domain, tileType, tile) {
  if (domain === 'air') return true;
  if (tileType === 'fog') return true;
  if (domain === 'land') return tileType === 'land' || tileType === 'city';
  if (domain === 'sea') {
    if (tileType === 'ocean') return true;
    if (tileType === 'city' && tile && tile.city && tile.city.coastal) return true;
    return false;
  }
  return false;
}

// ── BFS pathfinding ────────────────────────────────────────────────────────
function aiBFS(state, startX, startY, goalX, goalY, domain) {
  const { mapW, mapH } = state;
  if (startX === goalX && startY === goalY) return null;

  const visited = new Set([startY * mapW + startX]);
  const queue = [{ x: startX, y: startY, path: [] }];

  while (queue.length) {
    const { x, y, path } = queue.shift();
    for (const nb of hexNeighbors(x, y, mapW, mapH)) {
      const key = nb.y * mapW + nb.x;
      if (visited.has(key)) continue;
      visited.add(key);
      const tile = state.tiles[nb.y][nb.x];
      if (!tile || tile.type === 'void') continue;
      if (!checkMoveDomain(domain, tile.type, tile)) continue;
      if (getTileUnitCount(state, nb.x, nb.y) >= 2) {
        const hasEnemy = state.units.some(u => u.x === nb.x && u.y === nb.y);
        if (!hasEnemy) continue;
      }
      const newPath = [...path, { x: nb.x, y: nb.y }];
      if (nb.x === goalX && nb.y === goalY) return newPath[0] || null;
      queue.push({ x: nb.x, y: nb.y, path: newPath });
    }
  }
  return null;
}

// ── doMove ─────────────────────────────────────────────────────────────────
function doMove(state, unit, toX, toY, stats) {
  const { mapW, mapH } = state;
  if (toX < 0 || toX >= mapW || toY < 0 || toY >= mapH) return;
  const destTile = state.tiles[toY][toX];
  const def = UNIT_DEFS[unit.type];
  if (destTile.type === 'void') return;
  if (!checkMoveDomain(def.domain, destTile.type, destTile)) return;

  const enemies = state.units.filter(u => u.owner !== unit.owner && u.x === toX && u.y === toY);
  if (enemies.length === 0) {
    if (getTileUnitCount(state, toX, toY) >= 2) return;
  }

  for (const enemy of enemies) {
    const survivor = resolveCombat(state, unit, enemy, stats);
    if (!survivor || survivor.id !== unit.id) return;
    const stillExists = state.units.find(u => u.id === unit.id);
    const enemyStillExists = state.units.find(u => u.id === enemy.id);
    if (stillExists && enemyStillExists) return;
    if (!stillExists) return;
  }

  const isEnemyCity = destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner && destTile.city.owner !== 0;
  if (def.domain === 'air' && isEnemyCity) {
    unit.movesLeft = Math.max(0, unit.movesLeft - 1);
    if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
    return;
  }

  unit.x = toX; unit.y = toY;
  unit.movesLeft = Math.max(0, unit.movesLeft - 1);

  if (destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner) {
    if (def && def.canCapture) {
      destTile.city.owner = unit.owner;
      destTile.city.production = 'army';
      destTile.city.progress = 0;
      state.units = state.units.filter(u => u.id !== unit.id);
      return;
    }
  }

  if (unit.fuel !== null) {
    const onFriendlyCity = destTile.type === 'city' && destTile.city && destTile.city.owner === unit.owner;
    const onFriendlyCarrier = state.units.some(u => u !== unit && u.owner === unit.owner && u.type === 'carrier' && u.x === toX && u.y === toY);
    if (onFriendlyCity || onFriendlyCarrier) unit.fuel = UNIT_DEFS[unit.type].fuel;
  }
}

// ── City counting ──────────────────────────────────────────────────────────
function countCities(state, player) {
  let count = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city' && t.city && t.city.owner === player) count++;
  return count;
}

function countTotalCities(state) {
  let count = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city') count++;
  return count;
}

// ── Win condition check (v2: 80% dominance for 5 turns OR annihilation) ────
function checkWin(state) {
  if (state.phase === 'ended') return;

  const p1Cities = countCities(state, 1);
  const p2Cities = countCities(state, 2);
  const p1Units  = state.units.filter(u => u.owner === 1).length;
  const p2Units  = state.units.filter(u => u.owner === 2).length;
  const total    = countTotalCities(state);

  // Annihilation: opponent has no cities AND no units
  if (p2Cities === 0 && p2Units === 0) {
    state.winner = 1;
    state.winReason = 'annihilation';
    state.phase = 'ended';
    return;
  }
  if (p1Cities === 0 && p1Units === 0) {
    state.winner = 2;
    state.winReason = 'annihilation';
    state.phase = 'ended';
    return;
  }

  // Dominance: hold >= 80% of all cities for 5 consecutive turns
  const threshold = 0.80;
  if (total > 0) {
    if (p1Cities / total >= threshold) {
      state.dominanceStreaks = state.dominanceStreaks || { 1: 0, 2: 0 };
      state.dominanceStreaks[1]++;
      state.dominanceStreaks[2] = 0;
      if (state.dominanceStreaks[1] >= 5) {
        state.winner = 1;
        state.winReason = 'dominance';
        state.phase = 'ended';
        return;
      }
    } else if (p2Cities / total >= threshold) {
      state.dominanceStreaks = state.dominanceStreaks || { 1: 0, 2: 0 };
      state.dominanceStreaks[2]++;
      state.dominanceStreaks[1] = 0;
      if (state.dominanceStreaks[2] >= 5) {
        state.winner = 2;
        state.winReason = 'dominance';
        state.phase = 'ended';
        return;
      }
    } else {
      if (state.dominanceStreaks) {
        state.dominanceStreaks[1] = 0;
        state.dominanceStreaks[2] = 0;
      }
    }
  }
}

// ── Production / Turn Advance ─────────────────────────────────────────────
function doProductionTick(state, playerNum) {
  for (let y = 0; y < state.mapH; y++) {
    for (let x = 0; x < state.mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (city.owner !== playerNum || !city.production) continue;
      city.progress++;
      const buildTime = UNIT_DEFS[city.production]?.buildTime || 99;
      if (city.progress >= buildTime) {
        const spawned = spawnUnit(state, city.owner, city.production, x, y);
        if (spawned) city.progress = 0;
      }
    }
  }
}

function doFuelBurn(state, playerNum) {
  for (const unit of [...state.units]) {
    if (unit.fuel === null || unit.owner !== playerNum) continue;
    const tile = state.tiles[unit.y][unit.x];
    const onCarrier = state.units.some(u => u !== unit && u.owner === playerNum && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
    const onFriendlyCity = tile.type === 'city' && tile.city && tile.city.owner === playerNum;
    if (onCarrier || onFriendlyCity) continue;
    unit.fuel = Math.max(0, unit.fuel - 1);
    if (unit.fuel <= 0) state.units = state.units.filter(u => u.id !== unit.id);
  }
}

// ── v2 HP regen: 20% of maxHp per turn ────────────────────────────────────
function restoreMovement(state, playerNum) {
  for (const unit of state.units) {
    if (unit.owner === playerNum) {
      unit.movesLeft = UNIT_DEFS[unit.type].move;
      unit.hasAttacked = false;
      // v2: 20% HP regen (ceil of 20%)
      if (unit.hp != null && unit.maxHp != null && unit.hp < unit.maxHp) {
        const regen = Math.ceil(unit.maxHp * 0.20);
        unit.hp = Math.min(unit.maxHp, unit.hp + regen);
      }
    }
  }
}

// ── AI Player ─────────────────────────────────────────────────────────────
function runAI(state, playerNum, stats) {
  const { mapW, mapH } = state;
  const opponent = playerNum === 1 ? 2 : 1;
  const aiVisible  = getVisibleTiles(state, playerNum);
  const aiExplored = state.exploredTiles ? state.exploredTiles[playerNum] : null;

  function aiCanSee(x, y) { return aiVisible.has(y * mapW + x); }

  const p1Units  = state.units.filter(u => u.owner === opponent && aiCanSee(u.x, u.y));
  const aiUnits  = state.units.filter(u => u.owner === playerNum);

  const neutralCities  = [];
  const friendlyCities = [];
  const enemyCities    = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const key = y * mapW + x;
      const known = aiVisible.has(key) || (aiExplored && aiExplored.has(key));
      if (!known) continue;
      const pos = { x, y, city: tile.city, tile };
      if (!tile.city.owner || tile.city.owner === 0) neutralCities.push(pos);
      else if (tile.city.owner === playerNum) friendlyCities.push(pos);
      else enemyCities.push(pos);
    }
  }

  const aiCounts = {};
  for (const u of aiUnits) aiCounts[u.type] = (aiCounts[u.type] || 0) + 1;
  const totalAI = aiUnits.length || 1;

  for (const cp of friendlyCities) {
    const tile = cp.tile;
    if (tile.city.production) continue;
    const isCoastal = tile.city.coastal;
    const enemyHasAir = p1Units.some(u => u.type === 'fighter' || u.type === 'bomber');
    const needFighters = enemyHasAir && (aiCounts['fighter'] || 0) < 2;
    const needNaval = isCoastal && (aiCounts['destroyer'] || 0) < 1;
    const tankRatio = (aiCounts['tank'] || 0) / totalAI;
    const infantryRatio = (aiCounts['army'] || 0) / totalAI;

    let prod;
    if (needFighters) prod = 'fighter';
    else if (needNaval) prod = 'destroyer';
    else if (tankRatio < 0.3) prod = 'tank';
    else if (infantryRatio < 0.4) prod = 'army';
    else if (isCoastal && (aiCounts['battleship'] || 0) < 1) prod = 'battleship';
    else prod = Math.random() < 0.6 ? 'tank' : 'army';

    tile.city.production = prod;
    tile.city.progress = 0;
  }

  function hpRatio(unit) { return unit.maxHp ? unit.hp / unit.maxHp : 1; }
  function nearestSafeBase(unit) {
    let best = null, bestD = Infinity;
    for (const fc of friendlyCities) {
      const d = hexDistance(unit.x, unit.y, fc.x, fc.y);
      if (d < bestD) { bestD = d; best = fc; }
    }
    return best;
  }
  function attackScore(attacker, defender) {
    let score = (1 - hpRatio(defender)) * 60;
    const valueMap = { battleship: 40, carrier: 40, bomber: 35, fighter: 30, tank: 20, destroyer: 20, army: 10, transport: 15, submarine: 15 };
    score += valueMap[defender.type] || 10;
    if (hpRatio(defender) < 0.3) score += 50;
    else if (hpRatio(defender) < 0.6) score += 20;
    if (hpRatio(attacker) < 0.4) score -= 15;
    return score;
  }
  function moveScore(unit, target, type) {
    const d = hexDistance(unit.x, unit.y, target.x, target.y);
    if (type === 'capture_enemy')   return 80 - d;
    if (type === 'capture_neutral') return 60 - d;
    if (type === 'advance_enemy')   return 30 - d * 0.5;
    if (type === 'retreat')         return 40;
    return 10;
  }

  // Track first contact
  if (!state.firstContact) {
    for (const unit of aiUnits) {
      const adjEnemies = state.units.filter(u => u.owner === opponent && hexDistance(unit.x, unit.y, u.x, u.y) <= 2);
      if (adjEnemies.length > 0) state.firstContact = state.turn;
    }
  }

  const movedIds = new Set();
  const unitQueue = [...aiUnits].sort((a, b) => {
    const aAdj = state.units.some(u => u.owner === opponent && hexDistance(a.x, a.y, u.x, u.y) === 1);
    const bAdj = state.units.some(u => u.owner === opponent && hexDistance(b.x, b.y, u.x, u.y) === 1);
    return (aAdj && !bAdj) ? -1 : (!aAdj && bAdj) ? 1 : 0;
  });

  for (const unit of unitQueue) {
    if (unit.movesLeft <= 0 || movedIds.has(unit.id)) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def) continue;
    const domain = def.domain;
    let bestAction = null, bestScore = -Infinity;

    // Low fuel: return to base
    if (unit.fuel !== null && unit.fuel <= Math.ceil(def.move * 0.4)) {
      const base = nearestSafeBase(unit);
      if (base) {
        const step = aiBFS(state, unit.x, unit.y, base.x, base.y, domain);
        if (step) { bestAction = { type: 'move', step }; bestScore = 1000; }
      }
    }

    if (bestScore < 900) {
      // A: Attack adjacent
      if (!unit.hasAttacked) {
        const adjEnemies = p1Units.filter(eu => hexDistance(unit.x, unit.y, eu.x, eu.y) === 1);
        for (const enemy of adjEnemies) {
          const sc = attackScore(unit, enemy) + 100;
          if (sc > bestScore) { bestScore = sc; bestAction = { type: 'attack_adjacent', enemy }; }
        }
      }

      // B: Move into enemy tile
      if (unit.movesLeft > 0) {
        for (const nb of hexNeighbors(unit.x, unit.y, mapW, mapH)) {
          const tile = state.tiles[nb.y][nb.x];
          if (!tile || !checkMoveDomain(domain, tile.type, tile)) continue;
          const enemies = state.units.filter(u => u.owner === opponent && u.x === nb.x && u.y === nb.y);
          if (enemies.length > 0) {
            const sc = attackScore(unit, enemies[0]) + 80;
            if (sc > bestScore) { bestScore = sc; bestAction = { type: 'move', step: { x: nb.x, y: nb.y } }; }
          }
        }
      }

      // C: Capture enemy city
      if (def.canCapture && unit.movesLeft > 0) {
        for (const ec of enemyCities) {
          const sc = moveScore(unit, ec, 'capture_enemy');
          if (sc > bestScore) {
            const step = aiBFS(state, unit.x, unit.y, ec.x, ec.y, domain);
            if (step) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }

      // D: Capture neutral city
      if (def.canCapture && unit.movesLeft > 0) {
        for (const nc of neutralCities) {
          const sc = moveScore(unit, nc, 'capture_neutral');
          if (sc > bestScore) {
            const step = aiBFS(state, unit.x, unit.y, nc.x, nc.y, domain);
            if (step) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }

      // E: Advance toward enemy
      if (unit.movesLeft > 0) {
        let bestTarget = null, bestTargetSc = -Infinity;
        for (const eu of p1Units) {
          const euDef = UNIT_DEFS[eu.type];
          if (!euDef) continue;
          if (domain === 'land' && euDef.domain === 'sea') continue;
          if (domain === 'sea'  && euDef.domain === 'land') continue;
          const d = hexDistance(unit.x, unit.y, eu.x, eu.y);
          const tsc = (1 - hpRatio(eu)) * 50 + 20 - d * 0.5;
          if (tsc > bestTargetSc) { bestTargetSc = tsc; bestTarget = eu; }
        }
        if (bestTarget) {
          const step = aiBFS(state, unit.x, unit.y, bestTarget.x, bestTarget.y, domain);
          if (step) {
            const sc = moveScore(unit, bestTarget, 'advance_enemy') + bestTargetSc * 0.3;
            if (sc > bestScore) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
        if (!bestAction && enemyCities.length > 0) {
          let best = null, bestD = Infinity;
          for (const ec of enemyCities) {
            const d = hexDistance(unit.x, unit.y, ec.x, ec.y);
            if (d < bestD) { bestD = d; best = ec; }
          }
          if (best) {
            const step = aiBFS(state, unit.x, unit.y, best.x, best.y, domain);
            if (step) { bestScore = 5; bestAction = { type: 'move', step }; }
          }
        }

        // Exploration fallback
        if (!bestAction && unit.movesLeft > 0) {
          let bestExploreTile = null, bestExploreDist = Infinity;
          for (let dy = -6; dy <= 6; dy++) {
            for (let dx = -6; dx <= 6; dx++) {
              const ex = unit.x + dx, ey = unit.y + dy;
              if (ex < 0 || ex >= mapW || ey < 0 || ey >= mapH) continue;
              const ek = ey * mapW + ex;
              if (aiVisible.has(ek) || (aiExplored && aiExplored.has(ek))) continue;
              const tile = state.tiles[ey][ex];
              if (!tile || tile.type === 'void') continue;
              if (!checkMoveDomain(domain, tile.type, tile)) continue;
              const d = hexDistance(unit.x, unit.y, ex, ey);
              if (d < bestExploreDist) { bestExploreDist = d; bestExploreTile = { x: ex, y: ey }; }
            }
          }
          if (bestExploreTile) {
            const step = aiBFS(state, unit.x, unit.y, bestExploreTile.x, bestExploreTile.y, domain);
            if (step) { bestScore = 2; bestAction = { type: 'move', step }; }
          }
        }
      }

      // F: Retreat
      if (hpRatio(unit) < 0.35 && unit.movesLeft > 0) {
        const base = (domain === 'land' || domain === 'air') ? nearestSafeBase(unit) : null;
        if (base) {
          const step = aiBFS(state, unit.x, unit.y, base.x, base.y, domain);
          if (step) {
            const sc = moveScore(unit, base, 'retreat');
            if (sc > bestScore) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }
    }

    if (bestAction) {
      if (bestAction.type === 'attack_adjacent') {
        const enemy = state.units.find(u => u.id === bestAction.enemy.id);
        if (enemy) {
          resolveCombat(state, unit, enemy, stats);
          unit.hasAttacked = true;
          if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
        }
        movedIds.add(unit.id);
      } else if (bestAction.type === 'move') {
        doMove(state, unit, bestAction.step.x, bestAction.step.y, stats);
        if (!unit.hasAttacked && unit.movesLeft >= 0) {
          const still = state.units.find(u => u.id === unit.id);
          if (still) {
            const freshAdj = state.units.filter(u => u.owner === opponent && hexDistance(still.x, still.y, u.x, u.y) === 1);
            if (freshAdj.length > 0) {
              const target = freshAdj.sort((a,b)=>(a.hp||99)-(b.hp||99))[0];
              const stillTarget = state.units.find(u => u.id === target.id);
              if (stillTarget) {
                resolveCombat(state, still, stillTarget, stats);
                still.hasAttacked = true;
                if (still.fuel !== null) still.fuel = Math.max(0, still.fuel - 1);
              }
            }
          }
        }
        movedIds.add(unit.id);
      }
    }
  }
}

// ── Create game state ──────────────────────────────────────────────────────
function createGameState() {
  const mapW = 20, mapH = 20;
  const mapData = generateMap(mapW, mapH);
  const { tiles, p1City, p2City } = mapData;

  tiles[p1City[1]][p1City[0]].city.owner = 1;
  tiles[p1City[1]][p1City[0]].city.production = 'army';
  tiles[p2City[1]][p2City[0]].city.owner = 2;
  tiles[p2City[1]][p2City[0]].city.production = 'army';

  const state = {
    phase: 'playing', players: {}, playerSockets: [null, null, null],
    tiles, units: [], turn: 1, activePlayer: 1,
    winner: null, winReason: null, firstContact: null,
    dominanceStreaks: { 1: 0, 2: 0 },
    exploredTiles: [null, new Set(), new Set()],
    mapW, mapH,
  };

  spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
  spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

  return state;
}

// ── Run a single game ──────────────────────────────────────────────────────
function runGame() {
  const state = createGameState();
  const stats = {
    attacksByPlayer: { 1: 0, 2: 0 },
    unitsLost: { 1: 0, 2: 0 },
    firstContact: null,
  };

  let halfTurnCount = 0;

  while (state.phase !== 'ended' && halfTurnCount < MAX_TURNS * 2) {
    const currentPlayer = state.activePlayer;
    const opponent = currentPlayer === 1 ? 2 : 1;

    runAI(state, currentPlayer, stats);

    if (!stats.firstContact && state.firstContact)
      stats.firstContact = state.firstContact;

    doFuelBurn(state, opponent);
    doProductionTick(state, opponent);
    restoreMovement(state, opponent);

    checkWin(state);
    if (state.phase === 'ended') break;

    if (currentPlayer === 1) {
      state.activePlayer = 2;
    } else {
      state.activePlayer = 1;
      state.turn++;
    }
    halfTurnCount++;
  }

  // If hit cap, mark as turn cap
  if (state.phase !== 'ended') {
    state.winner = null;
    state.winReason = 'turn_cap';
  }

  return {
    winner: state.winner,
    winReason: state.winReason,
    turns: state.turn,
    p1Cities: countCities(state, 1),
    p2Cities: countCities(state, 2),
    p1Attacks: stats.attacksByPlayer[1] || 0,
    p2Attacks: stats.attacksByPlayer[2] || 0,
    firstContact: stats.firstContact,
    stats,
    state,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('\n🎮 Stratcon AI vs AI — v2 Simulation (5 games, 20×20 map)');
console.log('   HP regen: 20% maxHp/turn | Win: 80% cities × 5 turns OR annihilation');
console.log('━'.repeat(65));

const results = [];

for (let g = 0; g < NUM_GAMES; g++) {
  process.stdout.write(`  Game ${g+1}/${NUM_GAMES}... `);
  const r = runGame();
  results.push(r);

  const winnerStr = r.winner ? `P${r.winner} wins (${r.winReason})` : `No winner (${r.winReason})`;
  const fc = r.firstContact != null ? `turn ${r.firstContact}` : 'never';
  console.log(`${winnerStr} | Turns: ${r.turns} | P1 cities: ${r.p1Cities} P2 cities: ${r.p2Cities} | Attacks P1: ${r.p1Attacks} P2: ${r.p2Attacks} | First contact: ${fc}`);
}

// ── Aggregate ──────────────────────────────────────────────────────────────
const p1Wins = results.filter(r => r.winner === 1).length;
const p2Wins = results.filter(r => r.winner === 2).length;
const draws  = results.filter(r => !r.winner).length;
const domWins = results.filter(r => r.winReason === 'dominance').length;
const annWins = results.filter(r => r.winReason === 'annihilation').length;
const capEnds = results.filter(r => r.winReason === 'turn_cap').length;

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

const avgTurns = avg(results.map(r => r.turns));
const avgP1Cities = avg(results.map(r => r.p1Cities));
const avgP2Cities = avg(results.map(r => r.p2Cities));
const avgP1Attacks = avg(results.map(r => r.p1Attacks));
const avgP2Attacks = avg(results.map(r => r.p2Attacks));
const contactList = results.map(r => r.firstContact).filter(f => f != null);
const avgFirstContact = avg(contactList);

console.log('\n' + '━'.repeat(65));
console.log('📊 V2 SIMULATION SUMMARY');
console.log('━'.repeat(65));
console.log(`\n🏆 Win Rates:`);
console.log(`   P1 wins:    ${p1Wins}/${NUM_GAMES}`);
console.log(`   P2 wins:    ${p2Wins}/${NUM_GAMES}`);
console.log(`   Draws:      ${draws}/${NUM_GAMES} (turn cap at ${MAX_TURNS})`);
console.log(`\n🎯 Win Methods:`);
console.log(`   Dominance:    ${domWins}   (80% cities × 5 turns)`);
console.log(`   Annihilation: ${annWins}`);
console.log(`   Turn cap:     ${capEnds}`);
console.log(`\n📏 Game Length:`);
console.log(`   Avg turns: ${avgTurns.toFixed(1)} | Min: ${Math.min(...results.map(r=>r.turns))} | Max: ${Math.max(...results.map(r=>r.turns))}`);
console.log(`\n🏙️  Cities at end:`);
console.log(`   Avg P1 cities: ${avgP1Cities.toFixed(1)}`);
console.log(`   Avg P2 cities: ${avgP2Cities.toFixed(1)}`);
console.log(`\n⚔️  Attacks:`);
console.log(`   Avg P1 attacks: ${avgP1Attacks.toFixed(1)}`);
console.log(`   Avg P2 attacks: ${avgP2Attacks.toFixed(1)}`);
console.log(`\n🔭 First contact:`);
console.log(`   Avg turn: ${contactList.length ? avgFirstContact.toFixed(1) : 'never'} | Games with contact: ${contactList.length}/${NUM_GAMES}`);

console.log('\n' + '━'.repeat(65));
console.log('📋 Per-Game Results:');
console.log('━'.repeat(65));
console.log('  #  Winner   WinReason     Turns  P1Cit P2Cit P1Atk P2Atk Contact');
console.log('  ─'.repeat(33));
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const winner = r.winner ? `P${r.winner}     ` : 'Draw   ';
  const reason = (r.winReason || 'none').padEnd(13);
  const fc = r.firstContact != null ? `t${r.firstContact}` : 'none';
  console.log(`  ${i+1}  ${winner}  ${reason} ${String(r.turns).padStart(4)}   ${String(r.p1Cities).padStart(3)}   ${String(r.p2Cities).padStart(3)}   ${String(r.p1Attacks).padStart(3)}   ${String(r.p2Attacks).padStart(3)}   ${fc}`);
}
console.log('\n' + '━'.repeat(65));

// ── Save Discord summary JSON ──────────────────────────────────────────────
const fs = require('fs');
const summary = {
  version: 'v2',
  numGames: NUM_GAMES,
  p1Wins, p2Wins, draws,
  domWins, annWins, capEnds,
  avgTurns: +avgTurns.toFixed(1),
  avgP1Cities: +avgP1Cities.toFixed(1),
  avgP2Cities: +avgP2Cities.toFixed(1),
  avgP1Attacks: +avgP1Attacks.toFixed(1),
  avgP2Attacks: +avgP2Attacks.toFixed(1),
  avgFirstContact: contactList.length ? +avgFirstContact.toFixed(1) : null,
  results: results.map((r, i) => ({
    game: i+1, winner: r.winner, winReason: r.winReason, turns: r.turns,
    p1Cities: r.p1Cities, p2Cities: r.p2Cities,
    p1Attacks: r.p1Attacks, p2Attacks: r.p2Attacks,
    firstContact: r.firstContact,
  })),
};

fs.writeFileSync('/home/node/.openclaw/workspace/stratcon/ai-sim-v2-results.json', JSON.stringify(summary, null, 2));
console.log('✅ Results saved to ai-sim-v2-results.json\n');
