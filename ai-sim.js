/**
 * ai-sim.js — Headless AI vs AI simulation for Stratcon
 * Runs N games on a small 20x20 map and prints an analysis report.
 * 
 * Usage: node ai-sim.js
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const MAP_W_DEFAULT = 20, MAP_H_DEFAULT = 20;
const NUM_GAMES = 10;
const MAX_TURNS = 300; // safety cutoff

// Unit stats
const UNIT_DEFS = {
  army:       { buildTime: 1,  move: 1,  domain: 'land',  fuel: null, carries: null,      canCapture: true,  symbol: '🪖', slots: 1,  maxHp: 3  },
  tank:       { buildTime: 2,  move: 2,  domain: 'land',  fuel: null, carries: null,      canCapture: true,  symbol: '🛡️', slots: 2,  maxHp: 6  },
  fighter:    { buildTime: 4,  move: 10, domain: 'air',   fuel: 10,   carries: null,      canCapture: false, symbol: '✈️', slots: 0,  maxHp: 6  },
  bomber:     { buildTime: 5,  move: 15, domain: 'air',   fuel: 15,   carries: null,      canCapture: false, symbol: '💣', slots: 0,  maxHp: 8  },
  submarine:  { buildTime: 4,  move: 4,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '🤿', hidden: true, slots: 0, maxHp: 4 },
  destroyer:  { buildTime: 4,  move: 4,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '🚢', slots: 0,  maxHp: 5  },
  transport:  { buildTime: 3,  move: 3,  domain: 'sea',   fuel: null, carries: 'army',    canCapture: false, capacity: 3, symbol: '⛴️', slots: 0, maxHp: 10 },
  carrier:    { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: 'fighter', canCapture: false, capacity: 8, symbol: '🛳️', slots: 0, maxHp: 10 },
  battleship: { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '⚓', slots: 0,  maxHp: 10 },
};

// ── Hex neighbor tables (pointy-top, odd-r offset) ─────────────────────────
const HEX_NEIGHBORS_EVEN = [
  [1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1],
];
const HEX_NEIGHBORS_ODD = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1],
];

function hexNeighbors(col, row, mapW, mapH) {
  const dirs = (row % 2 === 0) ? HEX_NEIGHBORS_EVEN : HEX_NEIGHBORS_ODD;
  const result = [];
  for (const [dc, dr] of dirs) {
    const nc = col + dc, nr = row + dr;
    if (nc >= 0 && nc < mapW && nr >= 0 && nr < mapH)
      result.push({ x: nc, y: nr });
  }
  return result;
}

function hexDistance(c1, r1, c2, r2) {
  function offsetToCube(col, row) {
    const x = col - (row - (row & 1)) / 2;
    const z = row;
    const y = -x - z;
    return { x, y, z };
  }
  const a = offsetToCube(c1, r1);
  const b = offsetToCube(c2, r2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

function offsetToCube(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  const y = -x - z;
  return { x, y, z };
}

function isInHexBounds(col, row, mapW, mapH) {
  const centerCol = mapW / 2;
  const centerRow = mapH / 2;
  const radius = Math.floor(mapW / 2);
  const a = offsetToCube(col, row);
  const b = offsetToCube(centerCol, centerRow);
  const dist = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  return dist <= radius;
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
  const W = mapW || MAP_W_DEFAULT;
  const H = mapH || MAP_H_DEFAULT;
  const tiles = [];
  const noise = [];
  for (let i = 0; i < W * H; i++) noise.push(Math.random());

  function idx(x, y) { return y * W + x; }
  const smoothed = noise.slice();
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              sum += smoothed[idx(nx, ny)]; count++;
            }
          }
        }
        smoothed[idx(x, y)] = sum / count;
      }
    }
  }

  const inBoundValues = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isInHexBounds(x, y, W, H)) inBoundValues.push(smoothed[idx(x, y)]);

  const sorted = inBoundValues.slice().sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.52)];

  for (let y = 0; y < H; y++) {
    tiles.push([]);
    for (let x = 0; x < W; x++) {
      if (!isInHexBounds(x, y, W, H)) {
        tiles[y].push({ type: 'void', owner: null, city: null });
        continue;
      }
      const v = smoothed[idx(x, y)];
      tiles[y].push({ type: v >= threshold ? 'land' : 'ocean', owner: null, city: null });
    }
  }

  function isCoastal(x, y) {
    for (const nb of hexNeighbors(x, y, W, H)) {
      const t = tiles[nb.y][nb.x];
      if (t.type === 'ocean') return true;
    }
    return false;
  }

  const visited = new Set();
  const landmasses = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (tiles[y][x].type !== 'ocean' && tiles[y][x].type !== 'void' && !visited.has(y * W + x)) {
        const mass = [];
        const queue = [[x, y]];
        while (queue.length) {
          const [cx, cy] = queue.shift();
          const k = cy * W + cx;
          if (visited.has(k)) continue;
          visited.add(k);
          mass.push([cx, cy]);
          for (const nb of hexNeighbors(cx, cy, W, H)) {
            const nt = tiles[nb.y][nb.x];
            if (!visited.has(nb.y * W + nb.x) && nt.type !== 'ocean' && nt.type !== 'void')
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
      for (const [ex, ey] of cities)
        if (hexDistance(cx, cy, ex, ey) < minDist) { tooClose = true; break; }
      if (!tooClose) { placeCity(cx, cy); return true; }
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
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = tiles[y][x];
      if (t.type === 'land') allLandTiles.push([x, y]);
    }
  shuffle(allLandTiles);
  for (const [lx, ly] of allLandTiles) {
    const nearCity = cities.some(([cx, cy]) => hexDistance(lx, ly, cx, cy) <= maxCityDist);
    if (!nearCity) {
      let tooClose = false;
      for (const [ex, ey] of cities)
        if (hexDistance(lx, ly, ex, ey) < minDist) { tooClose = true; break; }
      if (!tooClose) placeCity(lx, ly);
    }
  }

  for (const [cx, cy] of cities)
    if (tiles[cy][cx].city) tiles[cy][cx].city.coastal = isCoastal(cx, cy);

  let p1City = null, p2City = null;
  for (const [x, y] of cities) {
    if (!p1City && x < W / 2 && y < H / 2) p1City = [x, y];
    if (!p2City && x >= W / 2 && y >= H / 2) p2City = [x, y];
  }
  if (!p1City) p1City = cities[0];
  if (!p2City) p2City = cities[cities.length - 1];

  return { tiles, cities, p1City, p2City };
}

// ── Unit Stacking ──────────────────────────────────────────────────────────
function getTileUnitCount(state, x, y) {
  return state.units.filter(u => u.x === x && u.y === y).length;
}

let uidCounter = 0;
function newUid() { return ++uidCounter; }

function spawnUnit(state, owner, type, x, y) {
  const count = getTileUnitCount(state, x, y);
  if (count >= 2) return null;
  if (state.tiles[y] && state.tiles[y][x] && state.tiles[y][x].type === 'void') return null;
  const def = UNIT_DEFS[type];
  const unit = {
    id: newUid(),
    owner,
    type,
    x, y,
    movesLeft: def.move,
    fuel: def.fuel,
    hp: def.maxHp,
    maxHp: def.maxHp,
    cargo: [],
    symbol: def.symbol,
  };
  state.units.push(unit);
  return unit;
}

// ── Fog of War ─────────────────────────────────────────────────────────────
function getVisibleTiles(state, playerNum) {
  const mapW = state.mapW;
  const mapH = state.mapH;
  const visible = new Set();
  const range = 2;

  function reveal(cx, cy) {
    const queue = [[cx, cy, 0]];
    const seen = new Set();
    seen.add(cy * mapW + cx);
    visible.add(cy * mapW + cx);
    while (queue.length) {
      const [qx, qy, dist] = queue.shift();
      if (dist >= range) continue;
      for (const nb of hexNeighbors(qx, qy, mapW, mapH)) {
        if (state.tiles[nb.y][nb.x].type === 'void') continue;
        const k = nb.y * mapW + nb.x;
        if (!seen.has(k)) {
          seen.add(k);
          visible.add(k);
          queue.push([nb.x, nb.y, dist + 1]);
        }
      }
    }
  }

  for (const unit of state.units) {
    if (unit.owner === playerNum) reveal(unit.x, unit.y);
  }
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const t = state.tiles[y][x];
      if (t.type === 'city' && t.city && t.city.owner === playerNum) reveal(x, y);
    }
  }

  if (state.exploredTiles && state.exploredTiles[playerNum]) {
    for (const k of visible) state.exploredTiles[playerNum].add(k);
  }

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

  let atkRoll, defRoll, atkDmg, defDmg;
  let rolls = 0;
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

  // Record stats
  if (stats) {
    stats.attacksTotal++;
    stats.attacksByTurn[state.turn] = (stats.attacksByTurn[state.turn] || 0) + 1;
    const owner = attacker.owner;
    if (defenderDied) stats.unitsLost[defender.owner] = (stats.unitsLost[defender.owner] || 0) + 1;
    if (attackerDied) stats.unitsLost[attacker.owner] = (stats.unitsLost[attacker.owner] || 0) + 1;
  }

  let outcome;
  if (attackerDied && defenderDied) {
    state.units = state.units.filter(u => u.id !== attacker.id && u.id !== defender.id);
    outcome = 'mutual_kill';
  } else if (defenderDied) {
    state.units = state.units.filter(u => u.id !== defender.id);
    outcome = 'attacker_wins';
  } else if (attackerDied) {
    state.units = state.units.filter(u => u.id !== attacker.id);
    outcome = 'defender_wins';
  } else {
    outcome = 'both_survived';
  }

  if (outcome === 'attacker_wins') return attacker;
  if (outcome === 'mutual_kill') return null;
  if (outcome === 'defender_wins') return null;
  return attacker;
}

// ── Movement Domain Check ──────────────────────────────────────────────────
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

// ── BFS Pathfinding ────────────────────────────────────────────────────────
function aiBFS(state, startX, startY, goalX, goalY, domain) {
  const mapW = state.mapW;
  const mapH = state.mapH;

  if (startX === goalX && startY === goalY) return null;

  const visited = new Set();
  const queue = [{ x: startX, y: startY, path: [] }];
  visited.add(startY * mapW + startX);

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
        // Check for enemies to fight at destination
        const ownerFilter = domain === 'land' ? [1, 2] : [1, 2];
        // Allow moving into tiles with enemies
        const hasEnemy = state.units.some(u => u.x === nb.x && u.y === nb.y);
        if (!hasEnemy) continue;
      }

      const newPath = [...path, { x: nb.x, y: nb.y }];

      if (nb.x === goalX && nb.y === goalY) {
        return newPath[0] || null;
      }

      queue.push({ x: nb.x, y: nb.y, path: newPath });
    }
  }
  return null;
}

// ── doMove ─────────────────────────────────────────────────────────────────
function doMove(state, unit, toX, toY, stats) {
  const mapW = state.mapW;
  const mapH = state.mapH;
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

  unit.x = toX;
  unit.y = toY;
  unit.movesLeft = Math.max(0, unit.movesLeft - 1);

  if (destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner) {
    if (def && def.canCapture) {
      // Track city captures
      if (stats) {
        stats.citiesCapturedByTurn[state.turn] = (stats.citiesCapturedByTurn[state.turn] || 0) + 1;
        stats.citiesCapturedBy[unit.owner] = (stats.citiesCapturedBy[unit.owner] || 0) + 1;
      }
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
    if (onFriendlyCity || onFriendlyCarrier) {
      unit.fuel = UNIT_DEFS[unit.type].fuel;
    }
  }
}

// ── Win Condition Check ────────────────────────────────────────────────────
function countCities(state, player) {
  let count = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city' && t.city && t.city.owner === player) count++;
  return count;
}

function checkWin(state) {
  const p1Cities = countCities(state, 1);
  const p2Cities = countCities(state, 2);
  const p1Units = state.units.filter(u => u.owner === 1).length;
  const p2Units = state.units.filter(u => u.owner === 2).length;

  if (p2Cities === 0 && p2Units === 0) {
    state.winner = 1;
    state.phase = 'ended';
  } else if (p1Cities === 0 && p1Units === 0) {
    state.winner = 2;
    state.phase = 'ended';
  }
}

// ── Production / Turn Advance ─────────────────────────────────────────────
function doProductionTick(state, playerNum) {
  const mapW = state.mapW;
  const mapH = state.mapH;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (city.owner !== playerNum || !city.production) continue;
      city.progress++;
      const buildTime = UNIT_DEFS[city.production] ? UNIT_DEFS[city.production].buildTime : 99;
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
    if (unit.fuel <= 0) {
      state.units = state.units.filter(u => u.id !== unit.id);
    }
  }
}

function restoreMovement(state, playerNum) {
  for (const unit of state.units) {
    if (unit.owner === playerNum) {
      unit.movesLeft = UNIT_DEFS[unit.type].move;
      unit.hasAttacked = false;
      if (unit.hp != null && unit.maxHp != null && unit.hp < unit.maxHp) {
        const regen = Math.ceil(unit.maxHp / 3);
        unit.hp = Math.min(unit.maxHp, unit.hp + regen);
      }
    }
  }
}

// ── AI Player (generic, works for both P1 and P2) ─────────────────────────
function runAI(state, playerNum, stats) {
  const mapW = state.mapW;
  const mapH = state.mapH;
  const opponent = playerNum === 1 ? 2 : 1;

  // Full visibility for simulation (no fog)
  const aiVisible  = getVisibleTiles(state, playerNum);
  const aiExplored = state.exploredTiles ? state.exploredTiles[playerNum] : null;

  function aiCanSee(x, y) { return aiVisible.has(y * mapW + x); }

  const p1Units = state.units.filter(u => u.owner === opponent && aiCanSee(u.x, u.y));
  const aiUnits = state.units.filter(u => u.owner === playerNum);

  // City classification
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

  // Production: set production for each friendly city
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

  function hpRatio(unit) {
    if (!unit.maxHp) return 1;
    return unit.hp / unit.maxHp;
  }

  function nearestSafeBase(unit) {
    let best = null, bestD = Infinity;
    for (const fc of friendlyCities) {
      const d = hexDistance(unit.x, unit.y, fc.x, fc.y);
      if (d < bestD) { bestD = d; best = fc; }
    }
    return best;
  }

  function attackScore(attacker, defender) {
    let score = 0;
    const defHpRatio = hpRatio(defender);
    score += (1 - defHpRatio) * 60;
    const valueMap = { battleship: 40, carrier: 40, bomber: 35, fighter: 30, tank: 20, destroyer: 20, army: 10, transport: 15, submarine: 15 };
    score += valueMap[defender.type] || 10;
    if (defHpRatio < 0.3) score += 50;
    else if (defHpRatio < 0.6) score += 20;
    if (hpRatio(attacker) < 0.4) score -= 15;
    return score;
  }

  function moveScore(unit, target, type) {
    const d = hexDistance(unit.x, unit.y, target.x, target.y);
    if (type === 'capture_enemy')  return 80 - d;
    if (type === 'capture_neutral') return 60 - d;
    if (type === 'advance_enemy')  return 30 - d * 0.5;
    if (type === 'retreat')        return 40;
    return 10;
  }

  const movedIds = new Set();

  const unitQueue = [...aiUnits].sort((a, b) => {
    const aAdj = state.units.some(u => u.owner === opponent && hexDistance(a.x, a.y, u.x, u.y) === 1);
    const bAdj = state.units.some(u => u.owner === opponent && hexDistance(b.x, b.y, u.x, u.y) === 1);
    if (aAdj && !bAdj) return -1;
    if (!aAdj && bAdj) return 1;
    return 0;
  });

  // Track first contact
  if (!state.firstContact) {
    for (const unit of aiUnits) {
      const adjEnemies = state.units.filter(u => u.owner === opponent && hexDistance(unit.x, unit.y, u.x, u.y) <= 2);
      if (adjEnemies.length > 0) {
        state.firstContact = state.turn;
      }
    }
  }

  for (const unit of unitQueue) {
    if (unit.movesLeft <= 0 || movedIds.has(unit.id)) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def) continue;

    const domain = def.domain;
    let bestAction = null;
    let bestScore = -Infinity;

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
          if (sc > bestScore) {
            bestScore = sc;
            bestAction = { type: 'attack_adjacent', enemy };
          }
        }
      }

      // B: Move into enemy tile
      if (unit.movesLeft > 0) {
        const nbs = hexNeighbors(unit.x, unit.y, mapW, mapH);
        for (const nb of nbs) {
          const tile = state.tiles[nb.y][nb.x];
          if (!tile || !checkMoveDomain(domain, tile.type, tile)) continue;
          const enemies = state.units.filter(u => u.owner === opponent && u.x === nb.x && u.y === nb.y);
          if (enemies.length > 0) {
            const sc = attackScore(unit, enemies[0]) + 80;
            if (sc > bestScore) {
              bestScore = sc;
              bestAction = { type: 'move', step: { x: nb.x, y: nb.y } };
            }
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
              const target = freshAdj.sort((a, b) => (a.hp || 99) - (b.hp || 99))[0];
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

// ── Create Game State ──────────────────────────────────────────────────────
function createGameState(mapSize) {
  const mapW = mapSize === 'small' ? 20 : mapSize === 'medium' ? 30 : 40;
  const mapH = mapSize === 'small' ? 20 : mapSize === 'medium' ? 30 : 40;

  const mapData = generateMap(mapW, mapH);
  const { tiles, p1City, p2City } = mapData;

  tiles[p1City[1]][p1City[0]].city.owner = 1;
  tiles[p1City[1]][p1City[0]].city.production = 'army';
  tiles[p2City[1]][p2City[0]].city.owner = 2;
  tiles[p2City[1]][p2City[0]].city.production = 'army';

  const state = {
    roomCode: 'SIM',
    phase: 'playing',
    players: {},
    playerSockets: [null, null, null],
    tiles,
    units: [],
    turn: 1,
    activePlayer: 1,
    turnEnded: [false, false, false],
    winner: null,
    firstContact: null,
    exploredTiles: [null, new Set(), new Set()],
    mapW,
    mapH,
  };

  spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
  spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

  return state;
}

// ── Run a single game ──────────────────────────────────────────────────────
function runGame(gameNum) {
  const state = createGameState('small');

  const stats = {
    attacksTotal: 0,
    attacksByTurn: {},
    citiesCapturedByTurn: {},
    citiesCapturedBy: { 1: 0, 2: 0 },
    unitsLost: { 1: 0, 2: 0 },
    firstContact: null,
    turnLog: [], // { turn, p1Cities, p2Cities, p1Units, p2Units, attacks }
  };

  let turnCount = 0;
  let prevAttacks = 0;

  while (state.phase !== 'ended' && turnCount < MAX_TURNS) {
    const currentPlayer = state.activePlayer;
    const opponent = currentPlayer === 1 ? 2 : 1;

    // Run AI for current player
    runAI(state, currentPlayer, stats);

    // Record first contact
    if (!stats.firstContact && state.firstContact) {
      stats.firstContact = state.firstContact;
    }

    // Production + fuel burn
    doFuelBurn(state, opponent);
    doProductionTick(state, opponent);

    // Restore movement for opponent
    restoreMovement(state, opponent);

    // Check win after each player's turn
    checkWin(state);

    // Log turn data
    const attacksThisTurn = stats.attacksTotal - prevAttacks;
    prevAttacks = stats.attacksTotal;
    stats.turnLog.push({
      turn: state.turn,
      player: currentPlayer,
      p1Cities: countCities(state, 1),
      p2Cities: countCities(state, 2),
      p1Units: state.units.filter(u => u.owner === 1).length,
      p2Units: state.units.filter(u => u.owner === 2).length,
      attacks: attacksThisTurn,
    });

    // Advance active player
    if (state.phase === 'ended') break;

    if (currentPlayer === 1) {
      state.activePlayer = 2;
    } else {
      state.activePlayer = 1;
      state.turn++;
    }

    turnCount++;
  }

  return {
    winner: state.winner,
    turns: state.turn,
    stats,
    state,
  };
}

// ── Analysis helpers ───────────────────────────────────────────────────────
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Main Simulation ────────────────────────────────────────────────────────
console.log(`\n🎮 Stratcon AI vs AI Simulation — ${NUM_GAMES} games on 20×20 map\n`);
console.log('━'.repeat(60));

const results = [];
const gameDetails = [];

for (let g = 0; g < NUM_GAMES; g++) {
  process.stdout.write(`  Game ${g+1}/${NUM_GAMES}... `);
  const result = runGame(g + 1);
  results.push(result);

  const { winner, turns, stats, state } = result;
  const winnerStr = winner ? `P${winner} wins` : 'Draw (timeout)';
  const fc = stats.firstContact || 'never';
  const totalAttacks = stats.attacksTotal;
  const attacksPerTurn = turns > 0 ? (totalAttacks / turns).toFixed(1) : 0;

  console.log(`${winnerStr} | Turn ${turns} | First contact: ${fc} | Attacks: ${totalAttacks} (${attacksPerTurn}/turn) | P1 lost: ${stats.unitsLost[1]}, P2 lost: ${stats.unitsLost[2]}`);
  gameDetails.push({ winner, turns, stats, firstContact: fc, attacksPerTurn: parseFloat(attacksPerTurn) });
}

// ── Aggregate Stats ────────────────────────────────────────────────────────
const p1Wins = results.filter(r => r.winner === 1).length;
const p2Wins = results.filter(r => r.winner === 2).length;
const draws  = results.filter(r => !r.winner).length;

const avgTurns = avg(results.map(r => r.turns));
const avgFirstContact = avg(results
  .map(r => r.stats.firstContact)
  .filter(fc => fc && fc !== 'never')
  .map(Number)
);

const avgAttacksPerTurn = avg(gameDetails.map(g => g.attacksPerTurn));

const avgP1Lost = avg(results.map(r => r.stats.unitsLost[1]));
const avgP2Lost = avg(results.map(r => r.stats.unitsLost[2]));

const avgP1Cities = avg(results.map(r => {
  const log = r.stats.turnLog;
  return log.length > 0 ? log[log.length-1].p1Cities : 0;
}));
const avgP2Cities = avg(results.map(r => {
  const log = r.stats.turnLog;
  return log.length > 0 ? log[log.length-1].p2Cities : 0;
}));

// ── Detailed Analysis ──────────────────────────────────────────────────────
// How quickly do cities get captured?
const allFirstCityCaptures = results.map(r => {
  const log = r.stats.turnLog;
  for (let i = 1; i < log.length; i++) {
    const prev = log[i-1];
    const curr = log[i];
    if (curr.p1Cities + curr.p2Cities > prev.p1Cities + prev.p2Cities) {
      return curr.turn;
    }
  }
  return null;
}).filter(Boolean);

const avgFirstCityCapture = avg(allFirstCityCaptures);

// How long before first attack?
const firstContactList = results.map(r => r.stats.firstContact).filter(fc => fc && fc !== 'never').map(Number);
const avgFirstContactTurn = avg(firstContactList);

// Neutrals captured vs enemy captured
const avgNeutralsP1 = avg(results.map(r => r.stats.citiesCapturedBy[1] || 0));
const avgNeutralsP2 = avg(results.map(r => r.stats.citiesCapturedBy[2] || 0));

// Turn progression analysis - where do games stall?
const attacksByTurnBucket = {}; // bucket of 5 turns
for (const r of results) {
  for (const [turn, attacks] of Object.entries(r.stats.attacksByTurn)) {
    const bucket = Math.floor(parseInt(turn) / 5) * 5;
    attacksByTurnBucket[bucket] = (attacksByTurnBucket[bucket] || 0) + attacks;
  }
}

// Print analysis
console.log('\n' + '━'.repeat(60));
console.log('📊 SIMULATION SUMMARY');
console.log('━'.repeat(60));
console.log(`\n🏆 Win Rates:`);
console.log(`   Player 1 (top-left): ${p1Wins}/${NUM_GAMES} (${(p1Wins/NUM_GAMES*100).toFixed(0)}%)`);
console.log(`   Player 2 (bot-right): ${p2Wins}/${NUM_GAMES} (${(p2Wins/NUM_GAMES*100).toFixed(0)}%)`);
if (draws > 0) console.log(`   Draws (timeout):     ${draws}/${NUM_GAMES}`);

console.log(`\n📏 Game Length:`);
console.log(`   Average turns: ${avgTurns.toFixed(1)}`);
console.log(`   Min: ${Math.min(...results.map(r => r.turns))} | Max: ${Math.max(...results.map(r => r.turns))}`);

console.log(`\n⚔️  Combat:`);
console.log(`   Avg attacks/turn: ${avgAttacksPerTurn.toFixed(2)}`);
console.log(`   Avg P1 units lost: ${avgP1Lost.toFixed(1)}`);
console.log(`   Avg P2 units lost: ${avgP2Lost.toFixed(1)}`);

console.log(`\n🏙️  Cities:`);
console.log(`   Avg first city captured: turn ${avgFirstCityCapture.toFixed(1)}`);
console.log(`   Avg total cities captured P1: ${avgNeutralsP1.toFixed(1)}`);
console.log(`   Avg total cities captured P2: ${avgNeutralsP2.toFixed(1)}`);
console.log(`   Avg P1 cities at end: ${avgP1Cities.toFixed(1)}`);
console.log(`   Avg P2 cities at end: ${avgP2Cities.toFixed(1)}`);

console.log(`\n🔭 Exploration:`);
console.log(`   Avg turn of first contact: ${avgFirstContactTurn.toFixed(1)}`);

console.log(`\n📈 Attack activity by turn range:`);
const bucketKeys = Object.keys(attacksByTurnBucket).map(Number).sort((a,b) => a-b);
for (const bucket of bucketKeys.slice(0, 12)) {
  const count = attacksByTurnBucket[bucket];
  const bar = '█'.repeat(Math.min(30, Math.ceil(count / 2)));
  console.log(`   Turns ${String(bucket).padStart(3)}-${String(bucket+4).padStart(3)}: ${bar} (${count})`);
}

// ── Bottleneck Analysis ────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(60));
console.log('🔍 BOTTLENECK ANALYSIS');
console.log('━'.repeat(60));

const bottlenecks = [];

if (avgFirstContactTurn > 10) {
  bottlenecks.push(`⚠️  Slow exploration: First contact at turn ${avgFirstContactTurn.toFixed(1)} — AI takes ${avgFirstContactTurn.toFixed(0)} turns before armies meet`);
}

if (avgAttacksPerTurn < 0.5) {
  bottlenecks.push(`⚠️  Low aggression: Only ${avgAttacksPerTurn.toFixed(2)} attacks/turn — AI is too passive/defensive`);
}

if (avgNeutralsP1 < 2 && avgNeutralsP2 < 2) {
  bottlenecks.push(`⚠️  City neglect: AI averages only ~${((avgNeutralsP1+avgNeutralsP2)/2).toFixed(1)} cities captured/player — neutral cities are being ignored`);
}

if (avgTurns > 150) {
  bottlenecks.push(`⚠️  Prolonged games: Avg ${avgTurns.toFixed(0)} turns — AI lacks closing instinct, games drag on`);
}

const firstBucketAttacks = attacksByTurnBucket[0] || 0;
const peakBucket = bucketKeys.reduce((best, k) => (attacksByTurnBucket[k] > (attacksByTurnBucket[best] || 0) ? k : best), 0);
if (peakBucket > 20) {
  bottlenecks.push(`⚠️  Late engagement: Combat peaks only at turns ${peakBucket}-${peakBucket+4} — early turns wasted`);
}

if (Math.abs(p1Wins - p2Wins) > NUM_GAMES * 0.3) {
  const dominant = p1Wins > p2Wins ? 'P1 (top-left)' : 'P2 (bottom-right)';
  bottlenecks.push(`⚠️  Positional imbalance: ${dominant} wins ${Math.max(p1Wins,p2Wins)}/${NUM_GAMES} — starting position or map layout advantages one side`);
}

if (bottlenecks.length === 0) {
  bottlenecks.push('✅ No major bottlenecks detected — AI performs reasonably well');
}

for (const b of bottlenecks) console.log(`  ${b}`);

// ── Recommendations ────────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(60));
console.log('💡 RECOMMENDATIONS FOR runAILevel3 TUNING');
console.log('━'.repeat(60));

const recommendations = [];

if (avgFirstContactTurn > 10) {
  recommendations.push({
    priority: 'HIGH',
    issue: 'Slow opening exploration',
    fix: `Increase exploration bonus weight from score 2 → 15. Add a "blitz phase" flag for turns 1-5 where units skip production-city-hunting and beeline toward center of map instead.`,
    code: `// In exploration fallback, change:\nif (step) { bestScore = 2; ... }\n// to:\nconst turnBonus = Math.max(0, 10 - state.turn);\nif (step) { bestScore = 15 + turnBonus; ... }`
  });
}

if (avgNeutralsP1 < 3 || avgNeutralsP2 < 3) {
  recommendations.push({
    priority: 'HIGH',
    issue: 'Neutral city capture neglect',
    fix: `Increase neutral city capture score from 60-d → 90-d. Spawn a dedicated "expander" unit (army) that ignores combat and only seeks neutral cities. Production decision: always build one army per neutral city on the map.`,
    code: `// In moveScore, change:\nif (type === 'capture_neutral') return 60 - d;\n// to:\nif (type === 'capture_neutral') return 90 - d * 0.5; // stronger pull`
  });
}

if (avgAttacksPerTurn < 0.5) {
  recommendations.push({
    priority: 'MEDIUM',
    issue: 'Low combat aggression',
    fix: `Lower the attack threshold. Currently "advance_enemy" score is 30-d*0.5 which is often beaten by neutral city captures. Give enemy-proximity a direct movement bonus: add +5 for each step closer to an enemy unit.`,
    code: `// In advance_enemy scoring:\nconst sc = moveScore(unit, bestTarget, 'advance_enemy') + bestTargetSc * 0.3;\n// Bump attack-move priority:\nconst sc = moveScore(unit, bestTarget, 'advance_enemy') + bestTargetSc * 0.5 + 10;`
  });
}

if (avgTurns > 100) {
  recommendations.push({
    priority: 'MEDIUM',
    issue: 'Games drag on without decisive action',
    fix: `Add a "siege mode" after turn 20: if AI owns >50% of cities and there are known enemy cities, skip neutral expansion and mass all units toward closest enemy city. Also: stack tanks as primary production (not army) to create faster-moving assault groups.`,
    code: `// Add before production decision:\nconst ownedCities = friendlyCities.length;\nconst totalKnownCities = friendlyCities.length + neutralCities.length + enemyCities.length;\nconst siegeMode = state.turn > 20 && ownedCities > totalKnownCities * 0.5;\nif (siegeMode) { prod = 'tank'; /* force tanks for fast push */ }`
  });
}

recommendations.push({
  priority: 'LOW',
  issue: 'Production decisions are reactive not strategic',
  fix: `Pre-compute "needed unit mix" at game start: 60% army (cap), 30% tank (speed+attack), 10% other. Always keep this ratio. Remove "coastal destroyer" early priority — on a 20x20 map, sea units are rarely decisive before game ends.`,
  code: `// Replace production logic with:\nconst armyRatio = (aiCounts['army']||0) / Math.max(1, totalAI);\nconst tankRatio  = (aiCounts['tank'] ||0) / Math.max(1, totalAI);\nif (armyRatio < 0.6) prod = 'army';\nelse if (tankRatio < 0.3) prod = 'tank';\nelse prod = 'army';`
});

recommendations.push({
  priority: 'LOW',
  issue: 'BFS path scoring ignores turn cost',
  fix: `aiBFS finds shortest path by hops but units have variable move speeds (army=1, tank=2). Weight paths by actual turns needed: dist/unit.movesLeft. This avoids slow armies wasting turns on long routes when a tank could arrive faster.`,
  code: `// Add turn-cost to score:\nconst turnsToReach = Math.ceil(d / (def.move || 1));\nif (type === 'capture_enemy')  return 80 - turnsToReach * 3;\nif (type === 'capture_neutral') return 90 - turnsToReach * 2;`
});

for (let i = 0; i < recommendations.length; i++) {
  const r = recommendations[i];
  console.log(`\n  [${i+1}] [${r.priority}] ${r.issue}`);
  console.log(`  Fix: ${r.fix}`);
  console.log(`  Code hint:\n${r.code.split('\n').map(l => '    ' + l).join('\n')}`);
}

// ── Generate Report Content ────────────────────────────────────────────────
const reportDate = new Date().toISOString();
const reportContent = `# AI Simulation Report — Stratcon
Generated: ${reportDate}
Map: 20×20 | Games: ${NUM_GAMES} | AI: runAILevel3 (P1) vs runAILevel3 (P2)

## Win Rates
| Player | Wins | Win Rate |
|--------|------|----------|
| Player 1 (top-left quadrant) | ${p1Wins} | ${(p1Wins/NUM_GAMES*100).toFixed(0)}% |
| Player 2 (bottom-right quadrant) | ${p2Wins} | ${(p2Wins/NUM_GAMES*100).toFixed(0)}% |
| Draws (timeout at ${MAX_TURNS} turns) | ${draws} | ${(draws/NUM_GAMES*100).toFixed(0)}% |

## Game Length
- Average: **${avgTurns.toFixed(1)} turns**
- Min: ${Math.min(...results.map(r => r.turns))} turns
- Max: ${Math.max(...results.map(r => r.turns))} turns

## First Contact
- Average turn of first contact: **${avgFirstContactTurn.toFixed(1)}**
- Games with contact before turn 10: ${firstContactList.filter(t => t <= 10).length}/${NUM_GAMES}

## Combat Statistics
- Average attacks per turn: **${avgAttacksPerTurn.toFixed(2)}**
- Average P1 units lost: ${avgP1Lost.toFixed(1)}
- Average P2 units lost: ${avgP2Lost.toFixed(1)}

## City Capture
- Average turn of first city captured: ${avgFirstCityCapture.toFixed(1) || 'N/A'}
- Average cities captured by P1: ${avgNeutralsP1.toFixed(1)}
- Average cities captured by P2: ${avgNeutralsP2.toFixed(1)}
- Average P1 cities at game end: ${avgP1Cities.toFixed(1)}
- Average P2 cities at game end: ${avgP2Cities.toFixed(1)}

## Attack Activity by Turn Range
${bucketKeys.slice(0, 12).map(bucket => {
  const count = attacksByTurnBucket[bucket] || 0;
  return `- Turns ${bucket}–${bucket+4}: ${count} attacks total across all games`;
}).join('\n')}

## Identified Bottlenecks
${bottlenecks.map(b => `- ${b}`).join('\n')}

## Recommendations (Tuning Weights in runAILevel3)

${recommendations.map((r, i) => `### [${i+1}] [${r.priority}] ${r.issue}
**Problem:** ${r.fix}

\`\`\`js
${r.code}
\`\`\`
`).join('\n')}

## Per-Game Results
| Game | Winner | Turns | First Contact | Attacks/Turn | P1 Lost | P2 Lost |
|------|--------|-------|---------------|--------------|---------|---------|
${results.map((r, i) => `| ${i+1} | ${r.winner ? `P${r.winner}` : 'Draw'} | ${r.turns} | ${r.stats.firstContact || 'never'} | ${gameDetails[i].attacksPerTurn} | ${r.stats.unitsLost[1]} | ${r.stats.unitsLost[2]} |`).join('\n')}
`;

const fs = require('fs');
const reportPath = '/home/node/.openclaw/workspace/stratcon/ai-sim-report.md';
fs.writeFileSync(reportPath, reportContent);
console.log(`\n✅ Report written to: ${reportPath}`);

// Export summary for Discord
const discordSummary = {
  p1WinRate: `${(p1Wins/NUM_GAMES*100).toFixed(0)}%`,
  p2WinRate: `${(p2Wins/NUM_GAMES*100).toFixed(0)}%`,
  avgTurns: avgTurns.toFixed(1),
  avgFirstContact: avgFirstContactTurn.toFixed(1),
  avgAttacksPerTurn: avgAttacksPerTurn.toFixed(2),
  bottlenecks,
  topRecommendations: recommendations.filter(r => r.priority === 'HIGH' || r.priority === 'MEDIUM').slice(0, 3),
};

fs.writeFileSync('/home/node/.openclaw/workspace/stratcon/ai-sim-discord.json', JSON.stringify(discordSummary, null, 2));
console.log('✅ Discord summary written to ai-sim-discord.json');
console.log('\n' + '━'.repeat(60) + '\n');
