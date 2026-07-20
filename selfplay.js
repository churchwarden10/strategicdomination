/**
 * selfplay.js — Strategic Domination: Level 3 AI vs Level 3 AI simulation
 * Runs 30 turns of AI self-play and reports results.
 */

'use strict';

// ── Inline all required code from server.js (no network/socket dependencies) ──

const MAP_W = 40, MAP_H = 40;

const UNIT_DEFS = {
  army:       { buildTime: 2,  move: 1,  domain: 'land',  fuel: null, carries: null,      canCapture: true,  symbol: '🪖', slots: 1 },
  tank:       { buildTime: 4,  move: 2,  domain: 'land',  fuel: null, carries: null,      canCapture: true,  symbol: '🛡️', slots: 2 },
  fighter:    { buildTime: 7,  move: 8,  domain: 'air',   fuel: 20,   carries: null,      canCapture: false, symbol: '✈️', slots: 0 },
  helicopter: { buildTime: 6,  move: 4,  domain: 'air',   fuel: 16,   carries: null,      canCapture: true,  symbol: '🚁', slots: 0 },
  destroyer:  { buildTime: 6,  move: 4,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '🚢', slots: 0 },
  submarine:  { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '🤿', hidden: true, slots: 0 },
  transport:  { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: 'army',    canCapture: false, capacity: 3, symbol: '⛴️', slots: 0 },
  carrier:    { buildTime: 12, move: 3,  domain: 'sea',   fuel: null, carries: 'fighter', canCapture: false, capacity: 8, symbol: '🛣️', slots: 0 },
  battleship: { buildTime: 14, move: 3,  domain: 'sea',   fuel: null, carries: null,      canCapture: false, symbol: '⚓', slots: 0 },
  bomber:     { buildTime: 5,  move: 6,  domain: 'air',   fuel: 10,   carries: null,      canCapture: false, symbol: '💣', slots: 0 },
};

const HEX_NEIGHBORS_EVEN = [
  [1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1],
];
const HEX_NEIGHBORS_ODD = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1],
];

function hexNeighbors(col, row, mapW, mapH) {
  const w = mapW !== undefined ? mapW : MAP_W;
  const h = mapH !== undefined ? mapH : MAP_H;
  const dirs = (row % 2 === 0) ? HEX_NEIGHBORS_EVEN : HEX_NEIGHBORS_ODD;
  const result = [];
  for (const [dc, dr] of dirs) {
    const nc = col + dc, nr = row + dr;
    if (nc >= 0 && nc < w && nr >= 0 && nr < h)
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
  const radius = Math.floor(mapW / 2) - 1;
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

function generateMap(mapW, mapH) {
  const W = mapW || MAP_W;
  const H = mapH || MAP_H;
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
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isInHexBounds(x, y, W, H)) inBoundValues.push(smoothed[idx(x, y)]);
    }
  }
  const sorted = inBoundValues.slice().sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.70)];

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

  function tryPlaceCity(candidates) {
    shuffle(candidates);
    for (const [cx, cy] of candidates) {
      let tooClose = false;
      for (const [ex, ey] of cities)
        if (hexDistance(cx, cy, ex, ey) < minDist) { tooClose = true; break; }
      if (!tooClose) {
        cities.push([cx, cy]);
        tiles[cy][cx].type = 'city';
        tiles[cy][cx].city = { owner: null, production: null, progress: 0, id: cities.length - 1, coastal: isCoastal(cx, cy) };
        return true;
      }
    }
    return false;
  }

  for (const mass of landmasses) {
    if (mass.length < 2) continue;
    const coastal = mass.filter(([x, y]) => isCoastal(x, y));
    const inland = mass.filter(([x, y]) => !isCoastal(x, y));
    tryPlaceCity(coastal);
    const remaining = [...coastal, ...inland];
    const slotsForMass = Math.max(0, Math.floor(mass.length / 15));
    for (let i = 0; i < slotsForMass; i++) tryPlaceCity(remaining);
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

function getUnitsOnTile(state, x, y) {
  return state.units.filter(u => u.x === x && u.y === y);
}

function getTileUnitCount(state, x, y) {
  return getUnitsOnTile(state, x, y).length;
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
    cargo: [],
    symbol: def.symbol,
  };
  state.units.push(unit);
  return unit;
}

function createGameState(forceSameLandmass) {
  // Try up to 20 times to get two starting cities on the same landmass
  for (let attempt = 0; attempt < 50; attempt++) {
    const mapW = 40, mapH = 40;
    const mapData = generateMap(mapW, mapH);
    const { tiles, p1City, p2City } = mapData;

    if (forceSameLandmass) {
      // Check landmass connectivity
      const visited = new Set();
      const queue = [[p1City[0], p1City[1]]];
      visited.add(p1City[1] * mapW + p1City[0]);
      let reachable = false;
      while (queue.length) {
        const [cx, cy] = queue.shift();
        if (cx === p2City[0] && cy === p2City[1]) { reachable = true; break; }
        for (const nb of hexNeighbors(cx, cy, mapW, mapH)) {
          const key = nb.y * mapW + nb.x;
          if (visited.has(key)) continue;
          const tile = tiles[nb.y][nb.x];
          if (!tile || (tile.type !== 'land' && tile.type !== 'city')) continue;
          visited.add(key);
          queue.push([nb.x, nb.y]);
        }
      }
      if (!reachable) continue; // Try again
    }

    tiles[p1City[1]][p1City[0]].city.owner = 1;
    tiles[p2City[1]][p2City[0]].city.owner = 2;

    const state = {
      roomCode: 'SELF',
      phase: 'playing',
      players: {},
      playerSockets: [null, null, null],
      tiles,
      units: [],
      turn: 1,
      activePlayer: 1,
      turnEnded: [false, false, false],
      turnTimer: null,
      turnDeadline: null,
      winner: null,
      exploredTiles: [null, new Set(), new Set()],
      mapW,
      mapH,
      vsComputer: false,
    };

    spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
    spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

    return state;
  }
  throw new Error('Could not generate a map with same-landmass starts after 20 attempts');
}

function getTransportUsedSlots(transport) {
  let used = 0;
  for (const cargo of transport.cargo) {
    const cDef = UNIT_DEFS[cargo.type];
    used += (cDef ? (cDef.slots || 1) : 1);
  }
  return used;
}

function checkMoveDomain(domain, tileType, tile) {
  if (domain === 'air') return true;
  if (domain === 'land') return tileType === 'land' || tileType === 'city';
  if (domain === 'sea') {
    if (tileType === 'ocean') return true;
    if (tileType === 'city' && tile && tile.city && tile.city.coastal) return true;
    return false;
  }
  return false;
}

function aiBFS(state, startX, startY, goalX, goalY, domain, ownerNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;

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

      // Check stacking — allow passing through if tile has enemies (can attack)
      if (getTileUnitCount(state, nb.x, nb.y) >= 2) {
        // Check if any unit is an enemy (attack path)
        const hasEnemies = ownerNum !== undefined &&
          state.units.some(u => u.owner !== ownerNum && u.x === nb.x && u.y === nb.y);
        if (!hasEnemies) continue; // full with friendlies or unknown, skip
      }

      const newPath = [...path, { x: nb.x, y: nb.y }];
      if (nb.x === goalX && nb.y === goalY) {
        return newPath[0] || null;
      }
      // If this tile has enemies, don't path through it (stop here for attack)
      if (ownerNum !== undefined &&
          state.units.some(u => u.owner !== ownerNum && u.x === nb.x && u.y === nb.y)) {
        // This is an enemy tile — don't continue BFS past it
        continue;
      }
      queue.push({ x: nb.x, y: nb.y, path: newPath });
    }
  }
  return null;
}

function onSameLandmass(state, x1, y1, x2, y2) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  const visited = new Set();
  const queue = [[x1, y1]];
  visited.add(y1 * mapW + x1);
  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (cx === x2 && cy === y2) return true;
    for (const nb of hexNeighbors(cx, cy, mapW, mapH)) {
      const key = nb.y * mapW + nb.x;
      if (visited.has(key)) continue;
      const tile = state.tiles[nb.y][nb.x];
      if (!tile || (tile.type !== 'land' && tile.type !== 'city')) continue;
      visited.add(key);
      queue.push([nb.x, nb.y]);
    }
  }
  return false;
}

function findNearestCoastalLand(state, fromX, fromY) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  let best = null, bestDist = Infinity;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'land' && tile.type !== 'city') continue;
      const nbs = hexNeighbors(x, y, mapW, mapH);
      const hasOceanNeighbor = nbs.some(nb => {
        const nt = state.tiles[nb.y][nb.x];
        return nt && (nt.type === 'ocean' || (nt.type === 'city' && nt.city && nt.city.coastal));
      });
      if (!hasOceanNeighbor) continue;
      const dist = hexDistance(fromX, fromY, x, y);
      if (dist < bestDist) { bestDist = dist; best = { x, y }; }
    }
  }
  return best;
}

function getValidMoves(state, unit, def) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  return hexNeighbors(unit.x, unit.y, mapW, mapH)
    .filter(p => {
      const tile = state.tiles[p.y][p.x];
      if (!tile || tile.type === 'void') return false;
      if (!checkMoveDomain(def.domain, tile.type, tile)) return false;
      if (getTileUnitCount(state, p.x, p.y) >= 2) {
        const enemies = state.units.filter(u => u.owner !== unit.owner && u.x === p.x && u.y === p.y);
        if (enemies.length === 0) return false;
      }
      return true;
    });
}

function findNearestUnit(state, unit, targetOwner) {
  let best = null, bestDist = Infinity;
  for (const u of state.units) {
    if (u.owner !== targetOwner) continue;
    const dist = hexDistance(unit.x, unit.y, u.x, u.y);
    if (dist < bestDist) { bestDist = dist; best = u; }
  }
  return best;
}

function findNearestCity(state, unit, ownerFilter) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  let best = null, bestDist = Infinity;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      if (!ownerFilter.includes(tile.city.owner)) continue;
      const dist = hexDistance(unit.x, unit.y, x, y);
      if (dist < bestDist) { bestDist = dist; best = { x, y }; }
    }
  }
  return best;
}

function countCities(state, player) {
  let count = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city' && t.city && t.city.owner === player) count++;
  return count;
}

// ── Combat log ──────────────────────────────────────────────────────────────
const combatLog = [];
const eventLog = [];

const UNIT_COMBAT = {
  army:       { attack: 1, defense: 2 },
  tank:       { attack: 3, defense: 3 },
  fighter:    { attack: 3, defense: 3 },
  helicopter: { attack: 2, defense: 2 },
  bomber:     { attack: 4, defense: 1 },
  destroyer:  { attack: 2, defense: 2 },
  submarine:  { attack: 2, defense: 1 },
  transport:  { attack: 0, defense: 1 },
  carrier:    { attack: 1, defense: 2 },
  battleship: { attack: 4, defense: 4 },
};

function resolveCombat(state, attacker, defender, turnNum) {
  const atkStats = UNIT_COMBAT[attacker.type] || { attack: 1, defense: 1 };
  const defStats = UNIT_COMBAT[defender.type] || { attack: 1, defense: 1 };

  const atkRoll = Math.ceil(Math.random() * 6);
  const atkHit = atkRoll <= atkStats.attack;

  let defRoll = null;
  let defHit = false;
  let outcome;

  if (atkHit) {
    defRoll = Math.ceil(Math.random() * 6);
    defHit = defRoll <= defStats.defense;

    state.units = state.units.filter(u => u.id !== defender.id);

    if (defHit) {
      state.units = state.units.filter(u => u.id !== attacker.id);
      outcome = 'mutual_kill';
    } else {
      outcome = 'attacker_wins';
    }
  } else {
    outcome = 'attacker_missed';
  }

  const report = {
    turn: turnNum,
    attackerType: attacker.type,
    attackerOwner: attacker.owner,
    attackerRoll: atkRoll,
    attackerTarget: atkStats.attack,
    attackerHit: atkHit,
    defenderType: defender.type,
    defenderOwner: defender.owner,
    defenderRoll: defRoll,
    defenderTarget: defStats.defense,
    defenderHit: defHit,
    outcome,
    location: { x: defender.x, y: defender.y },
  };

  combatLog.push(report);

  if (outcome === 'mutual_kill') return null;
  if (outcome === 'attacker_wins') return attacker;
  return attacker; // missed
}

// ── doMove adapted for selfplay (no socket emit) ──────────────────────────
function doMove(state, unit, toX, toY, turnNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  if (toX < 0 || toX >= mapW || toY < 0 || toY >= mapH) return;
  const destTile = state.tiles[toY][toX];
  const def = UNIT_DEFS[unit.type];
  if (!destTile || destTile.type === 'void') return;
  if (!checkMoveDomain(def.domain, destTile.type, destTile)) return;

  const enemies = state.units.filter(u => u.owner !== unit.owner && u.x === toX && u.y === toY);
  if (enemies.length === 0) {
    if (getTileUnitCount(state, toX, toY) >= 2) return;
  }

  for (const enemy of enemies) {
    const survivor = resolveCombat(state, unit, enemy, turnNum);
    if (!survivor || survivor.id !== unit.id) return;
    const stillExists = state.units.find(u => u.id === unit.id);
    const enemyStillExists = state.units.find(u => u.id === enemy.id);
    if (stillExists && enemyStillExists) return;
    if (!stillExists) return;
  }

  unit.x = toX;
  unit.y = toY;
  unit.movesLeft = Math.max(0, unit.movesLeft - 1);

  if (destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner) {
    if (def && def.canCapture) {
      const prevOwner = destTile.city.owner;
      destTile.city.owner = unit.owner;
      destTile.city.production = null;
      destTile.city.progress = 0;
      eventLog.push({
        turn: turnNum,
        type: 'city_capture',
        capturedBy: unit.owner,
        from: prevOwner,
        x: toX,
        y: toY,
      });
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

// ── checkWin (no timer, adapted) ──────────────────────────────────────────
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

// ── Production tick (no socket) ──────────────────────────────────────────
function runProductionTick(state, owner, turnNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (city.owner !== owner || !city.production) continue;
      city.progress++;
      const buildTime = UNIT_DEFS[city.production] ? UNIT_DEFS[city.production].buildTime : 99;
      if (city.progress >= buildTime) {
        const spawned = spawnUnit(state, city.owner, city.production, x, y);
        if (spawned) {
          city.progress = 0;
          eventLog.push({ turn: turnNum, type: 'unit_produced', owner, unitType: city.production, x, y });
        }
      }
    }
  }
}

// ── Fuel tick ────────────────────────────────────────────────────────────
function runFuelTick(state, owner, turnNum) {
  for (const unit of state.units.slice()) {
    if (unit.owner !== owner) continue;
    if (unit.fuel !== null) {
      unit.fuel = Math.max(0, unit.fuel - 1);
      if (unit.fuel <= 0) {
        const tile = state.tiles[unit.y][unit.x];
        const onCarrier = state.units.some(u => u !== unit && u.owner === unit.owner && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
        const onFriendlyCity = tile.type === 'city' && tile.city && tile.city.owner === unit.owner;
        if (!onCarrier && !onFriendlyCity) {
          eventLog.push({ turn: turnNum, type: 'unit_crash', owner: unit.owner, unitType: unit.type, x: unit.x, y: unit.y });
          state.units = state.units.filter(u => u.id !== unit.id);
        }
      }
    }
  }
}

// ── Full Level 3 AI runner (adapted for self-play, supports owner param) ──
function runAILevel3ForPlayer(state, aiOwner, turnNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  const enemyOwner = aiOwner === 1 ? 2 : 1;

  if (state.phase !== 'playing') return;

  const aiUnits = state.units.filter(u => u.owner === aiOwner);
  const enemyUnits = state.units.filter(u => u.owner === enemyOwner);

  const neutralCities = [];
  const friendlyCities = [];
  const enemyCities = [];
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const pos = { x, y, city: tile.city };
      if (!tile.city.owner || tile.city.owner === 0) neutralCities.push(pos);
      else if (tile.city.owner === aiOwner) friendlyCities.push(pos);
      else enemyCities.push(pos);
    }
  }

  const initKey = `ai3InitialCities_${aiOwner}`;
  if (!state[initKey]) state[initKey] = friendlyCities.length;
  const losingCities = friendlyCities.length < state[initKey];

  // Threat detection
  const threatenedCities = friendlyCities.filter(fc => {
    return enemyUnits.some(eu => hexDistance(fc.x, fc.y, eu.x, eu.y) <= 2);
  });
  const threatenedCitySet = new Set(threatenedCities.map(tc => `${tc.x},${tc.y}`));

  // Production
  for (const cp of friendlyCities) {
    const tile = state.tiles[cp.y][cp.x];
    if (!tile.city.production) {
      const isCoastal = tile.city.coastal;
      const aiHasTransport = state.units.some(u => u.owner === aiOwner && u.type === 'transport');
      const aiHasFighter = state.units.some(u => u.owner === aiOwner && u.type === 'fighter');
      const aiHasCarrier = state.units.some(u => u.owner === aiOwner && u.type === 'carrier');
      const enemyHasAir = enemyUnits.some(u => u.type === 'bomber' || u.type === 'fighter');

      let prod;
      if (losingCities) {
        prod = (Math.random() < 0.6) ? 'army' : 'tank';
      } else if (aiHasCarrier && !aiHasFighter) {
        prod = 'fighter';
      } else if (isCoastal && !aiHasTransport && !losingCities) {
        prod = 'transport';
      } else if (isCoastal && aiHasTransport && !losingCities) {
        prod = Math.random() < 0.5 ? 'destroyer' : 'battleship';
      } else if (enemyHasAir) {
        prod = 'fighter';
      } else {
        const r = Math.random();
        prod = r < 0.5 ? 'army' : (r < 0.75 ? 'tank' : 'bomber');
      }

      tile.city.production = prod;
      tile.city.progress = 0;
    }
  }

  const movedIds = new Set();

  const landAiUnits = aiUnits.filter(u => {
    const def = UNIT_DEFS[u.type];
    return def && def.domain === 'land' && u.movesLeft > 0;
  });

  function findEnemyCluster() {
    if (enemyUnits.length === 0) return null;
    let bestCluster = null, bestScore = -1;
    for (const eu of enemyUnits) {
      const nearby = enemyUnits.filter(other => hexDistance(eu.x, eu.y, other.x, other.y) <= 3);
      if (nearby.length > bestScore) { bestScore = nearby.length; bestCluster = eu; }
    }
    return bestCluster;
  }

  // Squad grouping
  const squads = [];
  const assignedToSquad = new Set();
  for (const u of landAiUnits) {
    if (assignedToSquad.has(u.id)) continue;
    const squad = [u];
    assignedToSquad.add(u.id);
    for (const other of landAiUnits) {
      if (assignedToSquad.has(other.id)) continue;
      if (hexDistance(u.x, u.y, other.x, other.y) <= 3) {
        squad.push(other);
        assignedToSquad.add(other.id);
      }
    }
    squads.push(squad);
  }

  // Priority 1: Defend threatened cities
  for (const tc of threatenedCities) {
    for (const unit of state.units) {
      if (unit.owner !== aiOwner || movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
      const def = UNIT_DEFS[unit.type];
      if (!def || def.domain !== 'land') continue;
      const distToCity = hexDistance(unit.x, unit.y, tc.x, tc.y);
      if (distToCity <= 4) {
        const step = aiBFS(state, unit.x, unit.y, tc.x, tc.y, def.domain, aiOwner);
        if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); break; }
      }
    }
  }

  // Priority 2: Retreat isolated units
  for (const unit of aiUnits) {
    if (movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def || def.domain !== 'land') continue;

    const friendlyNearby = state.units.filter(u =>
      u.owner === aiOwner && u.id !== unit.id && hexDistance(u.x, u.y, unit.x, unit.y) <= 2
    );
    const enemyNearby = enemyUnits.filter(eu => hexDistance(eu.x, eu.y, unit.x, unit.y) <= 2);

    if (friendlyNearby.length === 0 && enemyNearby.length >= 2) {
      let bestCity = null, bestDist = Infinity;
      for (const fc of friendlyCities) {
        const d = hexDistance(unit.x, unit.y, fc.x, fc.y);
        if (d < bestDist) { bestDist = d; bestCity = fc; }
      }
      if (bestCity && bestDist > 0) {
        const step = aiBFS(state, unit.x, unit.y, bestCity.x, bestCity.y, def.domain, aiOwner);
        if (step) {
          eventLog.push({ turn: turnNum, type: 'retreat', owner: aiOwner, unitType: unit.type });
          doMove(state, unit, step.x, step.y, turnNum);
          movedIds.add(unit.id);
        }
      }
    }
  }

  // Priority 3: Neutral city capture
  for (const nc of neutralCities) {
    if (landAiUnits.length === 0) break;
    let bestUnit = null, bestDist = Infinity;
    for (const u of landAiUnits) {
      if (movedIds.has(u.id)) continue;
      const d = hexDistance(u.x, u.y, nc.x, nc.y);
      if (d < bestDist) { bestDist = d; bestUnit = u; }
    }
    if (bestUnit) {
      const def = UNIT_DEFS[bestUnit.type];
      const step = aiBFS(state, bestUnit.x, bestUnit.y, nc.x, nc.y, def.domain, aiOwner);
      if (step) { doMove(state, bestUnit, step.x, step.y, turnNum); movedIds.add(bestUnit.id); }
    }
  }

  // Priority 4: Defend owned cities
  for (const fc of friendlyCities) {
    if (threatenedCitySet.has(`${fc.x},${fc.y}`)) continue;
    const onCity = state.units.filter(u => u.owner === aiOwner && u.x === fc.x && u.y === fc.y);
    if (onCity.length > 0) continue;

    let bestUnit = null, bestDist = Infinity;
    for (const u of state.units) {
      if (u.owner !== aiOwner || movedIds.has(u.id) || u.movesLeft <= 0) continue;
      const def = UNIT_DEFS[u.type];
      if (!def || def.domain !== 'land') continue;
      const d = hexDistance(u.x, u.y, fc.x, fc.y);
      if (d < bestDist) { bestDist = d; bestUnit = u; }
    }
    if (bestUnit && bestDist > 0) {
      const def = UNIT_DEFS[bestUnit.type];
      const step = aiBFS(state, bestUnit.x, bestUnit.y, fc.x, fc.y, def.domain, aiOwner);
      if (step) { doMove(state, bestUnit, step.x, step.y, turnNum); movedIds.add(bestUnit.id); }
    }
  }

  // Priority 5: Coordinated squad attacks
  const enemyCluster = findEnemyCluster();
  for (const squad of squads) {
    let objective = null;
    if (enemyCluster) {
      objective = { x: enemyCluster.x, y: enemyCluster.y };
    } else if (enemyCities.length > 0) {
      let best = null, bestD = Infinity;
      for (const ec of enemyCities) {
        const cx = squad.reduce((s, u) => s + u.x, 0) / squad.length;
        const cy = squad.reduce((s, u) => s + u.y, 0) / squad.length;
        const d = hexDistance(Math.round(cx), Math.round(cy), ec.x, ec.y);
        if (d < bestD) { bestD = d; best = ec; }
      }
      objective = best;
    }
    if (!objective) continue;
    for (const unit of squad) {
      if (movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
      const def = UNIT_DEFS[unit.type];
      if (!def) continue;
      const step = aiBFS(state, unit.x, unit.y, objective.x, objective.y, def.domain, aiOwner);
      if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); }
    }
  }

  // Priority 6: Naval escort
  const aiTransports = state.units.filter(u => u.owner === aiOwner && u.type === 'transport' && u.movesLeft > 0);
  for (const transport of aiTransports) {
    if (movedIds.has(transport.id)) continue;

    const escortNearby = state.units.some(u =>
      u.owner === aiOwner &&
      (u.type === 'destroyer' || u.type === 'battleship') &&
      hexDistance(u.x, u.y, transport.x, transport.y) <= 1
    );

    if (!escortNearby) {
      const escort = state.units.find(u =>
        u.owner === aiOwner && (u.type === 'destroyer' || u.type === 'battleship') && u.movesLeft > 0
      );
      if (escort) {
        const step = aiBFS(state, escort.x, escort.y, transport.x, transport.y, 'sea', aiOwner);
        if (step) { doMove(state, escort, step.x, step.y, turnNum); movedIds.add(escort.id); }
        movedIds.add(transport.id);
        continue;
      }
    }

    if (transport.cargo && transport.cargo.length === 0) {
      let strandedUnit = null;
      for (const lu of state.units) {
        if (lu.owner !== aiOwner || movedIds.has(lu.id)) continue;
        const def = UNIT_DEFS[lu.type];
        if (!def || def.domain !== 'land') continue;
        let hasPath = false;
        for (const ec of enemyCities) {
          if (onSameLandmass(state, lu.x, lu.y, ec.x, ec.y)) { hasPath = true; break; }
        }
        if (!hasPath && enemyCities.length > 0) { strandedUnit = lu; break; }
      }
      if (strandedUnit) {
        const step = aiBFS(state, transport.x, transport.y, strandedUnit.x, strandedUnit.y, 'sea', aiOwner);
        if (step) {
          doMove(state, transport, step.x, step.y, turnNum);
          movedIds.add(transport.id);
          const nbs = hexNeighbors(transport.x, transport.y, mapW, mapH);
          const isAdj = nbs.some(n => n.x === strandedUnit.x && n.y === strandedUnit.y);
          if ((isAdj || (transport.x === strandedUnit.x && transport.y === strandedUnit.y)) &&
              getTransportUsedSlots(transport) < 2) {
            const unitDef = UNIT_DEFS[strandedUnit.type];
            const slots = unitDef ? (unitDef.slots || 1) : 1;
            if (getTransportUsedSlots(transport) + slots <= 2) {
              if (isAdj) {
                strandedUnit.x = transport.x;
                strandedUnit.y = transport.y;
                strandedUnit.movesLeft = Math.max(0, strandedUnit.movesLeft - 1);
              }
              state.units = state.units.filter(u => u.id !== strandedUnit.id);
              transport.cargo.push({ ...strandedUnit });
              movedIds.add(strandedUnit.id);
            }
          }
        }
      }
    } else if (transport.cargo && transport.cargo.length > 0) {
      const target = enemyCities.length > 0 ? enemyCities[0] : findNearestCoastalLand(state, transport.x, transport.y);
      if (target) {
        const step = aiBFS(state, transport.x, transport.y, target.x, target.y, 'sea', aiOwner);
        if (step) { doMove(state, transport, step.x, step.y, turnNum); movedIds.add(transport.id); }
        const nbs = hexNeighbors(transport.x, transport.y, mapW, mapH);
        const landNbs = nbs.filter(nb => {
          const t = state.tiles[nb.y][nb.x];
          return t && (t.type === 'land' || t.type === 'city') && getTileUnitCount(state, nb.x, nb.y) < 2;
        });
        if (landNbs.length > 0 && transport.cargo.length > 0) {
          const unloadTo = landNbs[0];
          const cargo = transport.cargo.splice(0, 1)[0];
          cargo.x = unloadTo.x;
          cargo.y = unloadTo.y;
          cargo.movesLeft = UNIT_DEFS[cargo.type] ? UNIT_DEFS[cargo.type].move : 1;
          cargo.id = newUid();
          state.units.push(cargo);
        }
      }
    }
  }

  // Priority 7: Anti-air
  for (const unit of state.units) {
    if (unit.owner !== aiOwner || movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def || def.domain !== 'air') continue;

    if (unit.type === 'fighter') {
      let airTarget = null, airTargetPriority = Infinity;
      for (const eu of enemyUnits) {
        if (eu.type !== 'bomber' && eu.type !== 'fighter') continue;
        const d = hexDistance(unit.x, unit.y, eu.x, eu.y);
        const priority = eu.type === 'bomber' ? d - 1000 : d;
        if (priority < airTargetPriority) { airTargetPriority = priority; airTarget = eu; }
      }
      if (airTarget) {
        const step = aiBFS(state, unit.x, unit.y, airTarget.x, airTarget.y, 'air', aiOwner);
        if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); continue; }
      }
    }

    if (unit.type === 'bomber') {
      const safeTargets = [];
      for (const eu of enemyUnits) {
        const enemyFighterAdjacent = enemyUnits.some(ef =>
          ef.type === 'fighter' && hexDistance(ef.x, ef.y, eu.x, eu.y) <= 1
        );
        if (!enemyFighterAdjacent) safeTargets.push(eu);
      }
      const primaryTarget = safeTargets.length > 0
        ? safeTargets.reduce((a, b) =>
            hexDistance(unit.x, unit.y, a.x, a.y) < hexDistance(unit.x, unit.y, b.x, b.y) ? a : b
          )
        : null;
      const target = primaryTarget || (enemyUnits.length > 0 ? findNearestUnit(state, unit, enemyOwner) : null);
      if (target) {
        const step = aiBFS(state, unit.x, unit.y, target.x, target.y, 'air', aiOwner);
        if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); continue; }
      }
    }

    const enemy = findNearestUnit(state, unit, enemyOwner);
    if (enemy) {
      const step = aiBFS(state, unit.x, unit.y, enemy.x, enemy.y, 'air', aiOwner);
      if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); }
    } else if (enemyCities.length > 0) {
      let best = null, bestD = Infinity;
      for (const ec of enemyCities) {
        const d = hexDistance(unit.x, unit.y, ec.x, ec.y);
        if (d < bestD) { bestD = d; best = ec; }
      }
      if (best) {
        const step = aiBFS(state, unit.x, unit.y, best.x, best.y, 'air', aiOwner);
        if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); }
      }
    }
  }

  // Priority 8: Sea units (non-transport)
  for (const unit of state.units) {
    if (unit.owner !== aiOwner || movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def || def.domain !== 'sea' || unit.type === 'transport') continue;

    const enemyNaval = state.units.find(u => {
      if (u.owner !== enemyOwner) return false;
      const ud = UNIT_DEFS[u.type];
      return ud && ud.domain === 'sea';
    });

    let target = null;
    if (enemyNaval) {
      target = { x: enemyNaval.x, y: enemyNaval.y };
    } else if (enemyCities.length > 0) {
      target = findNearestCity(state, unit, [enemyOwner]);
    }
    if (target) {
      const step = aiBFS(state, unit.x, unit.y, target.x, target.y, 'sea', aiOwner);
      if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); }
    } else {
      const moves = getValidMoves(state, unit, def);
      if (moves.length > 0) {
        const m = moves[Math.floor(Math.random() * moves.length)];
        doMove(state, unit, m.x, m.y, turnNum);
        movedIds.add(unit.id);
      }
    }
  }

  // Priority 9: Remaining land units
  for (const unit of state.units) {
    if (unit.owner !== aiOwner || movedIds.has(unit.id) || unit.movesLeft <= 0) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def || def.domain !== 'land') continue;

    let target = null;
    if (enemyCities.length > 0) {
      let best = null, bestD = Infinity;
      for (const ec of enemyCities) {
        const d = hexDistance(unit.x, unit.y, ec.x, ec.y);
        if (d < bestD) { bestD = d; best = ec; }
      }
      target = best;
    } else if (neutralCities.length > 0) {
      let best = null, bestD = Infinity;
      for (const nc of neutralCities) {
        const d = hexDistance(unit.x, unit.y, nc.x, nc.y);
        if (d < bestD) { bestD = d; best = nc; }
      }
      target = best;
    }

    if (target) {
      const step = aiBFS(state, unit.x, unit.y, target.x, target.y, def.domain, aiOwner);
      if (step) { doMove(state, unit, step.x, step.y, turnNum); movedIds.add(unit.id); }
    } else {
      const moves = getValidMoves(state, unit, def);
      if (moves.length > 0) {
        const m = moves[Math.floor(Math.random() * moves.length)];
        doMove(state, unit, m.x, m.y, turnNum);
        movedIds.add(unit.id);
      }
    }
  }
}

// ── Main Self-Play Simulation ──────────────────────────────────────────────

const MAX_TURNS = parseInt(process.env.MAX_TURNS || '30');
const turnSummaries = [];
const bugs = [];

console.log('='.repeat(70));
console.log('STRATEGIC DOMINATION — Level 3 AI Self-Play Simulation');
console.log('='.repeat(70));
console.log(`Map size: ${MAP_W}x${MAP_H} | Max turns: ${MAX_TURNS}`);
console.log('');

// Force same-landmass for meaningful combat simulation
const state = createGameState(true);

// Diagnostic: Check if starting cities are on the same landmass
function checkSameLandmass(tiles, x1, y1, x2, y2, mapW, mapH) {
  const visited = new Set();
  const queue = [[x1, y1]];
  visited.add(y1 * mapW + x1);
  while (queue.length) {
    const [cx, cy] = queue.shift();
    if (cx === x2 && cy === y2) return true;
    for (const nb of hexNeighbors(cx, cy, mapW, mapH)) {
      const key = nb.y * mapW + nb.x;
      if (visited.has(key)) continue;
      const tile = tiles[nb.y][nb.x];
      if (!tile || (tile.type !== 'land' && tile.type !== 'city')) continue;
      visited.add(key);
      queue.push([nb.x, nb.y]);
    }
  }
  return false;
}

const p1StartUnit = state.units.find(u => u.owner === 1);
const p2StartUnit = state.units.find(u => u.owner === 2);
const sameLandmass = p1StartUnit && p2StartUnit &&
  checkSameLandmass(state.tiles, p1StartUnit.x, p1StartUnit.y, p2StartUnit.x, p2StartUnit.y, state.mapW, state.mapH);
const startDist = p1StartUnit && p2StartUnit ?
  hexDistance(p1StartUnit.x, p1StartUnit.y, p2StartUnit.x, p2StartUnit.y) : '?';
console.log(`Starting positions: P1=(${p1StartUnit ? p1StartUnit.x : '?'},${p1StartUnit ? p1StartUnit.y : '?'}) P2=(${p2StartUnit ? p2StartUnit.x : '?'},${p2StartUnit ? p2StartUnit.y : '?'})`);
console.log(`Same landmass: ${sameLandmass} | Starting distance: ${startDist} hexes`);
console.log('');

// Snapshot city counts at start
const totalCities = (() => {
  let c = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city') c++;
  return c;
})();
console.log(`Total cities on map: ${totalCities}`);
console.log(`P1 start cities: ${countCities(state, 1)} | P2 start cities: ${countCities(state, 2)}`);
console.log(`P1 start units: ${state.units.filter(u => u.owner === 1).length} | P2 start units: ${state.units.filter(u => u.owner === 2).length}`);
console.log('');

// Track unit counts for anomaly detection
const prevUnitCounts = { 1: state.units.filter(u => u.owner === 1).length, 2: state.units.filter(u => u.owner === 2).length };

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  if (state.phase !== 'playing') break;

  console.log(`--- Turn ${turn} ---`);

  const p1CitiesBefore = countCities(state, 1);
  const p2CitiesBefore = countCities(state, 2);
  const p1UnitsBefore = state.units.filter(u => u.owner === 1).length;
  const p2UnitsBefore = state.units.filter(u => u.owner === 2).length;

  // Restore moves for the active player
  const p1UnitsCurrent = state.units.filter(u => u.owner === 1);
  for (const u of p1UnitsCurrent) u.movesLeft = UNIT_DEFS[u.type].move;

  // Player 1 moves
  runAILevel3ForPlayer(state, 1, turn);

  // Production + fuel for P1
  runProductionTick(state, 1, turn);
  runFuelTick(state, 1, turn);
  checkWin(state);
  if (state.phase !== 'playing') break;

  // Restore moves for P2
  const p2UnitsCurrent = state.units.filter(u => u.owner === 2);
  for (const u of p2UnitsCurrent) u.movesLeft = UNIT_DEFS[u.type].move;

  // Player 2 moves
  runAILevel3ForPlayer(state, 2, turn);

  // Production + fuel for P2
  runProductionTick(state, 2, turn);
  runFuelTick(state, 2, turn);
  checkWin(state);

  const p1CitiesAfter = countCities(state, 1);
  const p2CitiesAfter = countCities(state, 2);
  const p1UnitsAfter = state.units.filter(u => u.owner === 1).length;
  const p2UnitsAfter = state.units.filter(u => u.owner === 2).length;

  // Anomaly detection: unexpected unit disappearances (more than production + combat can explain)
  const p1UnitDelta = p1UnitsAfter - p1UnitsBefore;
  const p2UnitDelta = p2UnitsAfter - p2UnitsBefore;

  // Count combats this turn
  const turnCombats = combatLog.filter(c => c.turn === turn);
  const p1Deaths = turnCombats.filter(c => c.defenderOwner === 1 && c.attackerHit).length +
                   turnCombats.filter(c => c.attackerOwner === 1 && c.defenderHit).length;
  const p2Deaths = turnCombats.filter(c => c.defenderOwner === 2 && c.attackerHit).length +
                   turnCombats.filter(c => c.attackerOwner === 2 && c.defenderHit).length;

  const turnEvents = eventLog.filter(e => e.turn === turn);
  const p1Produced = turnEvents.filter(e => e.type === 'unit_produced' && e.owner === 1).length;
  const p2Produced = turnEvents.filter(e => e.type === 'unit_produced' && e.owner === 2).length;
  const p1Crashes = turnEvents.filter(e => e.type === 'unit_crash' && e.owner === 1).length;
  const p2Crashes = turnEvents.filter(e => e.type === 'unit_crash' && e.owner === 2).length;
  const p1Captures = turnEvents.filter(e => e.type === 'city_capture' && e.capturedBy === 1).length;
  const p2Captures = turnEvents.filter(e => e.type === 'city_capture' && e.capturedBy === 2).length;
  const p1Retreats = turnEvents.filter(e => e.type === 'retreat' && e.owner === 1).length;
  const p2Retreats = turnEvents.filter(e => e.type === 'retreat' && e.owner === 2).length;

  // Expected P1 unit delta = produced - deaths - captures (unit consumed on city capture)
  const p1ExpectedDelta = p1Produced - p1Deaths - p1Captures - p1Crashes;
  const p2ExpectedDelta = p2Produced - p2Deaths - p2Captures - p2Crashes;

  if (Math.abs(p1UnitDelta - p1ExpectedDelta) > 2) {
    const bug = `Turn ${turn}: P1 unit delta anomaly: actual=${p1UnitDelta}, expected~${p1ExpectedDelta} (produced=${p1Produced}, deaths=${p1Deaths}, captures=${p1Captures}, crashes=${p1Crashes})`;
    bugs.push(bug);
    console.log(`  ⚠️  BUG: ${bug}`);
  }
  if (Math.abs(p2UnitDelta - p2ExpectedDelta) > 2) {
    const bug = `Turn ${turn}: P2 unit delta anomaly: actual=${p2UnitDelta}, expected~${p2ExpectedDelta} (produced=${p2Produced}, deaths=${p2Deaths}, captures=${p2Captures}, crashes=${p2Crashes})`;
    bugs.push(bug);
    console.log(`  ⚠️  BUG: ${bug}`);
  }

  const summary = {
    turn,
    p1Cities: p1CitiesAfter,
    p2Cities: p2CitiesAfter,
    p1Units: p1UnitsAfter,
    p2Units: p2UnitsAfter,
    p1Captures,
    p2Captures,
    combats: turnCombats.length,
    p1Deaths,
    p2Deaths,
    p1Produced,
    p2Produced,
    p1Crashes,
    p2Crashes,
    p1Retreats,
    p2Retreats,
  };
  turnSummaries.push(summary);

  // Print turn summary
  console.log(`  Cities: P1=${p1CitiesAfter}  P2=${p2CitiesAfter}`);
  console.log(`  Units:  P1=${p1UnitsAfter}   P2=${p2UnitsAfter}`);
  if (turnCombats.length > 0) {
    console.log(`  Combats: ${turnCombats.length} | P1 deaths: ${p1Deaths} | P2 deaths: ${p2Deaths}`);
    for (const c of turnCombats) {
      const outcomeStr = c.outcome === 'mutual_kill' ? '💥 MUTUAL KILL' :
                         c.outcome === 'attacker_wins' ? '⚔️  ATK WINS' : '🛡️  MISS';
      console.log(`    ${outcomeStr} — P${c.attackerOwner} ${c.attackerType} (roll ${c.attackerRoll}/${c.attackerTarget}) vs P${c.defenderOwner} ${c.defenderType} (roll ${c.defenderRoll ?? '-'}/${c.defenderTarget}) @ (${c.location.x},${c.location.y})`);
    }
  }
  if (p1Captures > 0) console.log(`  P1 captured ${p1Captures} city/cities`);
  if (p2Captures > 0) console.log(`  P2 captured ${p2Captures} city/cities`);
  if (p1Crashes > 0) console.log(`  P1 lost ${p1Crashes} air unit(s) to fuel crash`);
  if (p2Crashes > 0) console.log(`  P2 lost ${p2Crashes} air unit(s) to fuel crash`);
  if (p1Retreats > 0) console.log(`  P1 retreated ${p1Retreats} unit(s)`);
  if (p2Retreats > 0) console.log(`  P2 retreated ${p2Retreats} unit(s)`);
  if (p1Produced > 0) console.log(`  P1 produced ${p1Produced} unit(s)`);
  if (p2Produced > 0) console.log(`  P2 produced ${p2Produced} unit(s)`);

  if (state.phase !== 'playing') break;
}

// ── Final Report ──────────────────────────────────────────────────────────

console.log('');
console.log('='.repeat(70));
console.log('FINAL RESULTS');
console.log('='.repeat(70));

const finalP1Cities = countCities(state, 1);
const finalP2Cities = countCities(state, 2);
const finalP1Units = state.units.filter(u => u.owner === 1).length;
const finalP2Units = state.units.filter(u => u.owner === 2).length;

if (state.winner) {
  console.log(`\n🏆 WINNER: Player ${state.winner}!`);
} else {
  console.log(`\n⚖️  STALEMATE after ${MAX_TURNS} turns`);
}

console.log(`\nFinal State:`);
console.log(`  P1: ${finalP1Cities} cities, ${finalP1Units} units`);
console.log(`  P2: ${finalP2Cities} cities, ${finalP2Units} units`);

console.log('\nTurn-by-turn city counts:');
console.log('Turn | P1 Cities | P2 Cities | P1 Units | P2 Units | Combats');
console.log('-----|-----------|-----------|----------|----------|--------');
for (const s of turnSummaries) {
  console.log(`  ${String(s.turn).padStart(2)} |     ${String(s.p1Cities).padStart(5)} |     ${String(s.p2Cities).padStart(5)} |    ${String(s.p1Units).padStart(4)} |    ${String(s.p2Units).padStart(4)} |    ${String(s.combats).padStart(4)}`);
}

console.log(`\nTotal combats: ${combatLog.length}`);
const p1TotalKills = combatLog.filter(c => c.attackerOwner === 1 && c.attackerHit).length +
                     combatLog.filter(c => c.defenderOwner === 1 && c.defenderHit).length;
const p2TotalKills = combatLog.filter(c => c.attackerOwner === 2 && c.attackerHit).length +
                     combatLog.filter(c => c.defenderOwner === 2 && c.defenderHit).length;
const mutualKills = combatLog.filter(c => c.outcome === 'mutual_kill').length;
const attackerWins = combatLog.filter(c => c.outcome === 'attacker_wins').length;
const misses = combatLog.filter(c => c.outcome === 'attacker_missed').length;

console.log(`  Attacker wins: ${attackerWins} | Mutual kills: ${mutualKills} | Misses: ${misses}`);
console.log(`  P1 total kills: ${p1TotalKills} | P2 total kills: ${p2TotalKills}`);

const totalCaptures = eventLog.filter(e => e.type === 'city_capture').length;
const p1Captures = eventLog.filter(e => e.type === 'city_capture' && e.capturedBy === 1).length;
const p2Captures = eventLog.filter(e => e.type === 'city_capture' && e.capturedBy === 2).length;
const totalCrashes = eventLog.filter(e => e.type === 'unit_crash').length;
const totalRetreats = eventLog.filter(e => e.type === 'retreat').length;
console.log(`\nCity captures: ${totalCaptures} (P1: ${p1Captures}, P2: ${p2Captures})`);
console.log(`Air unit crashes: ${totalCrashes}`);
console.log(`Retreats triggered: ${totalRetreats}`);

// Production stats
const totalProduced = eventLog.filter(e => e.type === 'unit_produced').length;
const p1TotalProduced = eventLog.filter(e => e.type === 'unit_produced' && e.owner === 1).length;
const p2TotalProduced = eventLog.filter(e => e.type === 'unit_produced' && e.owner === 2).length;
console.log(`\nTotal units produced: ${totalProduced} (P1: ${p1TotalProduced}, P2: ${p2TotalProduced})`);

// Unit type breakdown
const unitTypesProduced = {};
for (const e of eventLog.filter(ev => ev.type === 'unit_produced')) {
  unitTypesProduced[e.unitType] = (unitTypesProduced[e.unitType] || 0) + 1;
}
console.log('Units produced by type:', JSON.stringify(unitTypesProduced, null, 2));

if (bugs.length > 0) {
  console.log('\n⚠️  ANOMALIES/BUGS DETECTED:');
  for (const b of bugs) console.log(`  - ${b}`);
} else {
  console.log('\n✅ No anomalies detected.');
}

console.log('');
console.log('='.repeat(70));

// Output structured data for report writing
const report = {
  winner: state.winner,
  stalemate: !state.winner,
  totalTurnsPlayed: turnSummaries.length,
  finalP1Cities,
  finalP2Cities,
  finalP1Units,
  finalP2Units,
  totalCombats: combatLog.length,
  attackerWins,
  mutualKills,
  misses,
  p1TotalKills,
  p2TotalKills,
  totalCaptures,
  p1Captures,
  p2Captures,
  totalCrashes,
  totalRetreats,
  totalProduced,
  p1TotalProduced,
  p2TotalProduced,
  unitTypesProduced,
  bugs,
  turnSummaries,
};

// Write JSON report
const fs = require('fs');
fs.writeFileSync(__dirname + '/selfplay_data.json', JSON.stringify(report, null, 2));
console.log('\nDetailed JSON data written to selfplay_data.json');
