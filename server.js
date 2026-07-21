const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Active Games API ───────────────────────────────────────────────────────
app.get('/api/games', (req, res) => {
  const active = [];
  for (const [code, state] of games.entries()) {
    if (state.phase === 'ended') continue;
    const players = Object.values(state.players)
      .filter(p => p.id === 1 || p.id === 2)
      .map(p => ({ id: p.id, name: p.name }));
    active.push({
      roomCode: code,
      phase: state.phase,
      turn: state.turn,
      vsComputer: state.vsComputer || false,
      players,
      mapSize: state.mapW <= 20 ? 'small' : state.mapW <= 30 ? 'medium' : 'large',
    });
  }
  res.json(active);
});

// ── Constants ──────────────────────────────────────────────────────────────
const MAP_W = 40, MAP_H = 40;
const TURN_SECONDS = 99999; // disabled for testing

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

// ── Hex boundary check ─────────────────────────────────────────────────────
function offsetToCube(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  const y = -x - z;
  return { x, y, z };
}

function isInHexBounds(col, row, mapW, mapH) {
  const centerCol = mapW / 2;
  const centerRow = mapH / 2;
  const radius = Math.floor(mapW / 2); // use full radius, no shrinkage
  const a = offsetToCube(col, row);
  const b = offsetToCube(centerCol, centerRow);
  const dist = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  return dist <= radius;
}

// ── Map Generation ─────────────────────────────────────────────────────────
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

  // Only consider tiles within hex bounds for threshold calculation
  const inBoundValues = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isInHexBounds(x, y, W, H)) inBoundValues.push(smoothed[idx(x, y)]);
    }
  }
  const sorted = inBoundValues.slice().sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.52)]; // ~48% land (was 30%)

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

  // isCoastal using hex neighbors (skip void)
  function isCoastal(x, y) {
    for (const nb of hexNeighbors(x, y, W, H)) {
      const t = tiles[nb.y][nb.x];
      if (t.type === 'ocean') return true;
    }
    return false;
  }

  // Identify landmasses via flood fill (only in-bound tiles)
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
  const maxCityDist = 10; // cities should be reachable within 10 tiles of another city

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
    // More cities per landmass (was /15, now /8)
    const slotsForMass = Math.max(0, Math.floor(mass.length / 8));
    for (let i = 0; i < slotsForMass; i++) tryPlaceCity(remaining);
  }

  // Ensure no land tile is more than maxCityDist from a city — add gap-fillers
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
      // Place a city here if it's not too close to existing ones
      let tooClose = false;
      for (const [ex, ey] of cities)
        if (hexDistance(lx, ly, ex, ey) < minDist) { tooClose = true; break; }
      if (!tooClose) placeCity(lx, ly);
    }
  }

  for (const [cx, cy] of cities)
    if (tiles[cy][cx].city) tiles[cy][cx].city.coastal = isCoastal(cx, cy);

  // Find starting cities in opposing quadrants
  let p1City = null, p2City = null;
  for (const [x, y] of cities) {
    if (!p1City && x < W / 2 && y < H / 2) p1City = [x, y];
    if (!p2City && x >= W / 2 && y >= H / 2) p2City = [x, y];
  }
  if (!p1City) p1City = cities[0];
  if (!p2City) p2City = cities[cities.length - 1];

  return { tiles, cities, p1City, p2City };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Unit Stacking Helper ───────────────────────────────────────────────────
// Returns units physically on a tile (not in cargo inside transports/carriers)
function getUnitsOnTile(state, x, y) {
  return state.units.filter(u => u.x === x && u.y === y);
}

const CONTAINER_TYPES = new Set(['transport', 'carrier']);

// Count hex slots used on a tile (containers count as 1, cargo inside containers doesn't count)
function getTileUnitCount(state, x, y) {
  return getUnitsOnTile(state, x, y).length;
}

// ── Game State ─────────────────────────────────────────────────────────────
const games = new Map();
let uidCounter = 0;
function newUid() { return ++uidCounter; }

function createGameState(roomCode, mapSize) {
  const mapW = mapSize === 'small' ? 20 : mapSize === 'medium' ? 30 : 40;
  const mapH = mapSize === 'small' ? 20 : mapSize === 'medium' ? 30 : 40;

  const mapData = generateMap(mapW, mapH);
  const { tiles, p1City, p2City } = mapData;

  tiles[p1City[1]][p1City[0]].city.owner = 1;
  tiles[p1City[1]][p1City[0]].city.production = 'army';
  tiles[p2City[1]][p2City[0]].city.owner = 2;
  tiles[p2City[1]][p2City[0]].city.production = 'army';

  const state = {
    roomCode,
    phase: 'waiting',
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
  };

  spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
  spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

  return state;
}

function spawnUnit(state, owner, type, x, y) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;

  // Check stacking limit (max 2 units per hex, containers count as 1 slot)
  const count = getTileUnitCount(state, x, y);
  if (count >= 2) return null; // tile full, skip spawn

  // Also ensure tile is not void
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

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (games.has(code));
  return code;
}

// ── Fog of War ─────────────────────────────────────────────────────────────
function getVisibleTiles(state, playerNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
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
        // Don't reveal through void tiles
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

function buildClientState(state, playerNum) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  const visible = getVisibleTiles(state, playerNum);
  const explored = state.exploredTiles ? state.exploredTiles[playerNum] : null;

  const clientTiles = state.tiles.map((row, y) =>
    row.map((tile, x) => {
      // Void tiles are always shown as void (no fog needed)
      if (tile.type === 'void') return { type: 'void' };

      const key = y * mapW + x;
      if (visible.has(key)) {
        const t = { type: tile.type };
        if (tile.city) {
          t.city = {
            owner: tile.city.owner,
            production: tile.city.production,
            progress: tile.city.progress,
            id: tile.city.id,
            coastal: tile.city.coastal,
          };
        }
        return t;
      } else if (explored && explored.has(key)) {
        const t = { type: tile.type, dimmed: true };
        if (tile.city) t.city = { owner: null, id: tile.city.id, coastal: tile.city.coastal };
        return t;
      } else {
        return { type: 'fog' };
      }
    })
  );

  const clientUnits = state.units
    .filter(u => {
      if (!visible.has(u.y * mapW + u.x)) return false;
      if (u.owner !== playerNum && UNIT_DEFS[u.type].hidden) {
        let found = false;
        for (const ou of state.units) {
          if (ou.owner === playerNum && hexDistance(ou.x, ou.y, u.x, u.y) <= 1) {
            found = true; break;
          }
        }
        return found;
      }
      return true;
    })
    .map(u => ({ ...u }));

  return {
    phase: state.phase,
    playerNum,
    turn: state.turn,
    turnDeadline: state.turnDeadline,
    tiles: clientTiles,
    units: clientUnits,
    myTurnEnded: state.turnEnded[playerNum],
    activePlayer: state.activePlayer,
    isMyTurn: state.activePlayer === playerNum,
    winner: state.winner,
    mapW,
    mapH,
  };
}

// ── Combat Stats ──────────────────────────────────────────────────────────
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

// ── Combat ─────────────────────────────────────────────────────────
// Damage-based HP combat:
//   - Roll d6 simultaneously. Hit if roll <= stat. Damage = roll value.
//   - Both-miss re-rolls silently. Units die at hp <= 0.
function resolveCombat(state, attacker, defender) {
  const atkStats = UNIT_COMBAT[attacker.type] || { attack: 1, defense: 1 };
  const defStats = UNIT_COMBAT[defender.type] || { attack: 1, defense: 1 };

  // Backfill HP for old units
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

  const report = {
    attackerType: attacker.type, attackerOwner: attacker.owner,
    attackerRoll: atkRoll, attackerTarget: atkStats.attack,
    attackerDmg: atkDmg, attackerHpLeft: attacker.hp,
    defenderType: defender.type, defenderOwner: defender.owner,
    defenderRoll: defRoll, defenderTarget: defStats.defense,
    defenderDmg: defDmg, defenderHpLeft: defender.hp,
    outcome, location: { x: defender.x, y: defender.y },
  };

  if (state.roomCode) io.to(state.roomCode).emit('battleReport', report);

  if (outcome === 'attacker_wins') return attacker;
  if (outcome === 'mutual_kill') return null;
  if (outcome === 'defender_wins') return null;
  return attacker;
}

// ── Turn / Production ──────────────────────────────────────────────────────
function advanceTurn(state) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;

  const nextPlayer = state.activePlayer === 1 ? 2 : 1;
  state.activePlayer = nextPlayer;
  state.turnEnded[1] = false;
  state.turnEnded[2] = false;

  if (nextPlayer === 1) state.turn++;

  for (const unit of state.units) {
    if (unit.owner === nextPlayer) {
      unit.movesLeft = UNIT_DEFS[unit.type].move;
      unit.hasAttacked = false;
      // HP regeneration: ceil(maxHp / 3) per turn, capped at maxHp
      if (unit.hp != null && unit.maxHp != null && unit.hp < unit.maxHp) {
        const regen = Math.ceil(unit.maxHp / 3);
        unit.hp = Math.min(unit.maxHp, unit.hp + regen);
      }
    }
  }

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (!city.owner || !city.production) continue;
      city.progress++;
      const buildTime = UNIT_DEFS[city.production] ? UNIT_DEFS[city.production].buildTime : 99;
      if (city.progress >= buildTime) {
        const spawned = spawnUnit(state, city.owner, city.production, x, y);
        if (spawned) city.progress = 0; // only reset if spawn succeeded; retry next turn if tile was full
      }
    }
  }

  // Fuel: at end of each turn, air units not on a safe landing spot burn 1 fuel.
  // If fuel hits 0 they crash immediately.
  for (const unit of [...state.units]) {
    if (unit.fuel === null) continue; // not an air unit
    const tile = state.tiles[unit.y][unit.x];
    const onCarrier = state.units.some(u => u !== unit && u.owner === unit.owner && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
    const onFriendlyCity = tile.type === 'city' && tile.city && tile.city.owner === unit.owner;
    if (onCarrier || onFriendlyCity) continue; // safely landed — no fuel burn, already refueled on landing
    // Airborne — burn 1 fuel for staying aloft
    unit.fuel = Math.max(0, unit.fuel - 1);
    if (unit.fuel <= 0) {
      // Crash
      state.units = state.units.filter(u => u.id !== unit.id);
      io.to(state.roomCode).emit('battleReport', {
        attackerType: unit.type, attackerOwner: unit.owner,
        defenderType: null, defenderOwner: null,
        outcome: 'fuel_crash', location: { x: unit.x, y: unit.y }
      });
    }
  }

  checkWin(state);

  state.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  clearTimeout(state.turnTimer);
  state.turnTimer = setTimeout(() => {
    advanceTurn(state);
    broadcastState(state);
  }, TURN_SECONDS * 1000);
}

function checkWin(state) {
  const p1Cities = countCities(state, 1);
  const p2Cities = countCities(state, 2);
  const p1Units = state.units.filter(u => u.owner === 1).length;
  const p2Units = state.units.filter(u => u.owner === 2).length;

  // Win = enemy has no cities AND no units left
  // (can't produce anything, can't fight back)
  if (p2Cities === 0 && p2Units === 0) {
    state.winner = 1;
    state.phase = 'ended';
    clearTimeout(state.turnTimer);
    scheduleGameCleanup(state);
  } else if (p1Cities === 0 && p1Units === 0) {
    state.winner = 2;
    state.phase = 'ended';
    clearTimeout(state.turnTimer);
    scheduleGameCleanup(state);
  }
}

function scheduleGameCleanup(state) {
  // Remove ended games from memory after 5 minutes so they don't accumulate
  setTimeout(() => {
    if (state.phase === 'ended') {
      games.delete(state.roomCode);
      console.log('Game cleaned up:', state.roomCode);
    }
  }, 5 * 60 * 1000);
}

function countCities(state, player) {
  let count = 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t.type === 'city' && t.city && t.city.owner === player) count++;
  return count;
}

function broadcastState(state) {
  for (const pid of [1, 2]) {
    const sock = state.playerSockets[pid];
    if (sock) {
      const cs = buildClientState(state, pid);
      sock.emit('stateUpdate', cs);
    }
  }
}

// ── AI Level 3: Threat-Aware AI ─────────────────────────────────────────

function runAILevel3(state) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  if (state.phase !== 'playing') return;

  // ── Fog of war: AI only knows what player 2 can currently see or has explored ──
  const aiVisible  = getVisibleTiles(state, 2); // tiles currently in sight
  const aiExplored = state.exploredTiles ? state.exploredTiles[2] : null;

  function aiCanSee(x, y) {
    return aiVisible.has(y * mapW + x);
  }

  // AI only sees enemy units in currently visible tiles
  const p1Units = state.units.filter(u => u.owner === 1 && aiCanSee(u.x, u.y));

  const aiUnits = state.units.filter(u => u.owner === 2);

  // ── City lists (fog-filtered: only cities AI has explored) ─────────────
  const neutralCities  = [];
  const friendlyCities = [];
  const enemyCities    = [];
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const key = y * mapW + x;
      // Only include cities the AI has seen (currently visible or previously explored)
      const known = aiVisible.has(key) || (aiExplored && aiExplored.has(key));
      if (!known) continue;
      const pos = { x, y, city: tile.city, tile };
      // For explored-but-not-currently-visible tiles, use last known ownership
      // (which is what's stored in state.tiles — same as a human would remember)
      if (!tile.city.owner || tile.city.owner === 0) neutralCities.push(pos);
      else if (tile.city.owner === 2) friendlyCities.push(pos);
      else enemyCities.push(pos);
    }
  }

  // ── Production ──────────────────────────────────────────────────────────
  // Smart production: count what we have and fill gaps
  const aiCounts = {};
  for (const u of aiUnits) aiCounts[u.type] = (aiCounts[u.type] || 0) + 1;
  const totalAI = aiUnits.length || 1;

  for (const cp of friendlyCities) {
    const tile = cp.tile;
    if (tile.city.production) continue; // already queued
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

  // ── Helpers ─────────────────────────────────────────────────────────────
  function nearestSafeBase(unit) {
    let best = null, bestD = Infinity;
    for (const fc of friendlyCities) {
      const d = hexDistance(unit.x, unit.y, fc.x, fc.y);
      if (d < bestD) { bestD = d; best = fc; }
    }
    for (const carrier of state.units) {
      if (carrier.owner !== 2 || carrier.type !== 'carrier') continue;
      const d = hexDistance(unit.x, unit.y, carrier.x, carrier.y);
      if (d < bestD) { bestD = d; best = { x: carrier.x, y: carrier.y }; }
    }
    return best;
  }

  function hpRatio(unit) {
    if (!unit.maxHp) return 1;
    return unit.hp / unit.maxHp;
  }

  // Score a potential attack on a defender by this attacker (higher = better)
  function attackScore(attacker, defender) {
    let score = 0;
    const defHpRatio = hpRatio(defender);
    // Big bonus for killing (low HP defender)
    score += (1 - defHpRatio) * 60;
    // Bonus for valuable targets
    const valueMap = { battleship: 40, carrier: 40, bomber: 35, fighter: 30, tank: 20, destroyer: 20, army: 10, transport: 15, submarine: 15 };
    score += valueMap[defender.type] || 10;
    // Prefer weakened defenders
    if (defHpRatio < 0.3) score += 50;
    else if (defHpRatio < 0.6) score += 20;
    // Penalty if attacker is low HP (risky attack)
    if (hpRatio(attacker) < 0.4) score -= 15;
    return score;
  }

  // Score a move toward a target (city capture, advance)
  function moveScore(unit, target, type) {
    const d = hexDistance(unit.x, unit.y, target.x, target.y);
    if (type === 'capture_enemy')  return 80 - d;
    if (type === 'capture_neutral') return 60 - d;
    if (type === 'advance_enemy')  return 30 - d * 0.5;
    if (type === 'retreat')        return 40;
    return 10;
  }

  // ── Main AI loop: score every action for every unit ────────────────────
  const movedIds = new Set();

  // Process each unit by priority: pick its best action and execute it
  // We run multiple passes so that attacking units can be prioritized
  const unitQueue = [...aiUnits].sort((a, b) => {
    // Prioritize units that are already adjacent to enemies
    const aAdj = state.units.some(u => u.owner === 1 && hexDistance(a.x, a.y, u.x, u.y) === 1);
    const bAdj = state.units.some(u => u.owner === 1 && hexDistance(b.x, b.y, u.x, u.y) === 1);
    if (aAdj && !bAdj) return -1;
    if (!aAdj && bAdj) return 1;
    return 0;
  });

  for (const unit of unitQueue) {
    if (unit.movesLeft <= 0 || movedIds.has(unit.id)) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def) continue;

    const domain = def.domain;
    let bestAction = null;
    let bestScore = -Infinity;

    // ── Air: return to base if low fuel ──────────────────────────────────
    if (unit.fuel !== null && unit.fuel <= Math.ceil(def.move * 0.4)) {
      const base = nearestSafeBase(unit);
      if (base) {
        const step = aiBFS(state, unit.x, unit.y, base.x, base.y, domain);
        if (step) { bestAction = { type: 'move', step }; bestScore = 1000; }
      }
    }

    if (bestScore < 900) {
      // ── Option A: Attack adjacent enemies ──────────────────────────────
      if (!unit.hasAttacked) {
        const adjEnemies = p1Units.filter(eu => hexDistance(unit.x, unit.y, eu.x, eu.y) === 1);
        for (const enemy of adjEnemies) {
          const sc = attackScore(unit, enemy) + 100; // Adjacent attack = high priority
          if (sc > bestScore) {
            bestScore = sc;
            bestAction = { type: 'attack_adjacent', enemy };
          }
        }
      }

      // ── Option B: Move into enemy tile (combat via doMove) ─────────────
      if (unit.movesLeft > 0) {
        const nbs = hexNeighbors(unit.x, unit.y, mapW, mapH);
        for (const nb of nbs) {
          const tile = state.tiles[nb.y][nb.x];
          if (!tile || !checkMoveDomain(domain, tile.type, tile)) continue;
          const enemies = state.units.filter(u => u.owner === 1 && u.x === nb.x && u.y === nb.y);
          if (enemies.length > 0) {
            const sc = attackScore(unit, enemies[0]) + 80;
            if (sc > bestScore) {
              bestScore = sc;
              bestAction = { type: 'move', step: { x: nb.x, y: nb.y } };
            }
          }
        }
      }

      // ── Option C: Capture enemy city ───────────────────────────────────
      if (def.canCapture && unit.movesLeft > 0) {
        for (const ec of enemyCities) {
          const sc = moveScore(unit, ec, 'capture_enemy');
          if (sc > bestScore) {
            const step = aiBFS(state, unit.x, unit.y, ec.x, ec.y, domain);
            if (step) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }

      // ── Option D: Capture neutral city ─────────────────────────────────
      if (def.canCapture && unit.movesLeft > 0) {
        for (const nc of neutralCities) {
          const sc = moveScore(unit, nc, 'capture_neutral');
          if (sc > bestScore) {
            const step = aiBFS(state, unit.x, unit.y, nc.x, nc.y, domain);
            if (step) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }

      // ── Option E: Advance toward lowest-HP enemy unit ──────────────────
      if (unit.movesLeft > 0) {
        // Find best enemy target: weight by HP and distance
        let bestTarget = null, bestTargetSc = -Infinity;
        for (const eu of p1Units) {
          // Domain filter: land/sea/air units shouldn't chase wrong domain
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
        // Fallback: advance toward nearest enemy city
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
        // Exploration fallback: if no enemy targets known, move toward nearest unexplored tile
        if (!bestAction && unit.movesLeft > 0) {
          let bestExploreTile = null, bestExploreDist = Infinity;
          // Sample candidate unexplored tiles near unit
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

      // ── Option F: Retreat damaged unit to nearest city ──────────────────
      if (hpRatio(unit) < 0.35 && unit.movesLeft > 0) {
        const base = domain === 'land' || domain === 'air' ? nearestSafeBase(unit) : null;
        if (base) {
          const step = aiBFS(state, unit.x, unit.y, base.x, base.y, domain);
          if (step) {
            const sc = moveScore(unit, base, 'retreat');
            if (sc > bestScore) { bestScore = sc; bestAction = { type: 'move', step }; }
          }
        }
      }
    }

    // ── Execute best action ────────────────────────────────────────────────
    if (bestAction) {
      if (bestAction.type === 'attack_adjacent') {
        // Use attackUnit logic directly (unit stays, deals damage)
        const enemy = state.units.find(u => u.id === bestAction.enemy.id);
        if (enemy) {
          resolveCombat(state, unit, enemy);
          unit.hasAttacked = true;
          if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
        }
        movedIds.add(unit.id);
      } else if (bestAction.type === 'move') {
        doMove(state, unit, bestAction.step.x, bestAction.step.y);
        // After moving, if now adjacent to enemy and hasn't attacked, attack immediately
        if (!unit.hasAttacked && unit.movesLeft >= 0) {
          const freshAdj = state.units.filter(u => u.owner === 1 && hexDistance(unit.x, unit.y, u.x, u.y) === 1);
          if (freshAdj.length > 0) {
            // Pick lowest HP adjacent enemy
            const target = freshAdj.sort((a, b) => (a.hp || 99) - (b.hp || 99))[0];
            const still = state.units.find(u => u.id === target.id);
            if (still) {
              resolveCombat(state, unit, still);
              unit.hasAttacked = true;
              if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
            }
          }
        }
        movedIds.add(unit.id);
      }
    }
  }

  // ── Transport logic ─────────────────────────────────────────────────────
  for (const transport of state.units) {
    if (transport.owner !== 2 || transport.type !== 'transport' || movedIds.has(transport.id)) continue;
    if (transport.cargo && transport.cargo.length > 0) {
      // Deliver to nearest enemy-coast land
      const target = enemyCities.length > 0 ? enemyCities[0] : findNearestCoastalLand(state, transport.x, transport.y);
      if (target) {
        const step = aiBFS(state, transport.x, transport.y, target.x, target.y, 'sea');
        if (step) doMove(state, transport, step.x, step.y);
        // Unload if adjacent to land
        const nbs = hexNeighbors(transport.x, transport.y, mapW, mapH);
        const landNbs = nbs.filter(nb => {
          const t = state.tiles[nb.y][nb.x];
          return t && (t.type === 'land' || t.type === 'city') && getTileUnitCount(state, nb.x, nb.y) < 2;
        });
        if (landNbs.length > 0 && transport.cargo.length > 0) {
          const unloadTo = landNbs[0];
          const cargo = transport.cargo.splice(0, 1)[0];
          cargo.x = unloadTo.x; cargo.y = unloadTo.y;
          cargo.movesLeft = UNIT_DEFS[cargo.type]?.move || 1;
          cargo.id = newUid();
          state.units.push(cargo);
        }
      }
    } else {
      // Pick up stranded land unit that can't reach enemy by land
      let strandedUnit = null;
      for (const lu of state.units) {
        if (lu.owner !== 2 || movedIds.has(lu.id)) continue;
        const luDef = UNIT_DEFS[lu.type];
        if (!luDef || luDef.domain !== 'land') continue;
        let hasPath = false;
        for (const ec of enemyCities) {
          if (onSameLandmass(state, lu.x, lu.y, ec.x, ec.y)) { hasPath = true; break; }
        }
        if (!hasPath && enemyCities.length > 0) { strandedUnit = lu; break; }
      }
      if (strandedUnit) {
        const step = aiBFS(state, transport.x, transport.y, strandedUnit.x, strandedUnit.y, 'sea');
        if (step) doMove(state, transport, step.x, step.y);
        const nbs = hexNeighbors(transport.x, transport.y, mapW, mapH);
        const isAdj = nbs.some(n => n.x === strandedUnit.x && n.y === strandedUnit.y);
        if (isAdj || (transport.x === strandedUnit.x && transport.y === strandedUnit.y)) {
          const slots = UNIT_DEFS[strandedUnit.type]?.slots || 1;
          if (getTransportUsedSlots(transport) + slots <= (UNIT_DEFS['transport'].capacity || 3)) {
            if (isAdj) { strandedUnit.x = transport.x; strandedUnit.y = transport.y; }
            state.units = state.units.filter(u => u.id !== strandedUnit.id);
            transport.cargo.push({ ...strandedUnit });
            movedIds.add(strandedUnit.id);
          }
        }
      }
    }
    movedIds.add(transport.id);
  }

  finishAITurn(state);
}


// ── AI BFS Pathfinding ────────────────────────────────────────────────
function aiBFS(state, startX, startY, goalX, goalY, domain) {
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

      // Don't move into full tiles unless there's an enemy
      if (getTileUnitCount(state, nb.x, nb.y) >= 2) {
        const enemies = state.units.filter(u => u.owner === 1 && u.x === nb.x && u.y === nb.y);
        if (enemies.length === 0) continue;
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

// Check if a hex position is on the same landmass as another position (no ocean crossing)
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

// Find nearest coastal tile adjacent to land from a sea position (for transport unload target)
function findNearestCoastalLand(state, fromX, fromY) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  let best = null, bestDist = Infinity;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'land' && tile.type !== 'city') continue;
      // Must be adjacent to an ocean tile the transport can reach
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

// ── AI Turn Wrap-up ──────────────────────────────────────────────────────
// Shared by all AI implementations: restore P1 moves, run production tick,
// check win condition, then send the updated state to player 1.
function finishAITurn(state) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;

  clearTimeout(state.turnTimer);
  state.turn++;
  state.activePlayer = 1;
  state.turnEnded[1] = false;
  state.turnEnded[2] = false;
  state.aiPending = false;

  // Restore player 1's movement points, reset attack flags, regen HP
  for (const unit of state.units) {
    if (unit.owner === 1) {
      unit.movesLeft = UNIT_DEFS[unit.type].move;
      unit.hasAttacked = false;
      if (unit.hp != null && unit.maxHp != null && unit.hp < unit.maxHp) {
        unit.hp = Math.min(unit.maxHp, unit.hp + Math.ceil(unit.maxHp / 3));
      }
    }
  }

  // Production tick for all cities
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (!city.owner || !city.production) continue;
      city.progress++;
      const buildTime = UNIT_DEFS[city.production] ? UNIT_DEFS[city.production].buildTime : 99;
      if (city.progress >= buildTime) {
        const spawned = spawnUnit(state, city.owner, city.production, x, y);
        if (spawned) city.progress = 0;
      }
    }
  }

  // Fuel burn at turn end for P1 air units not safely landed
  for (const unit of [...state.units]) {
    if (unit.fuel === null || unit.owner !== 1) continue;
    const tile = state.tiles[unit.y][unit.x];
    const onCarrier = state.units.some(u => u !== unit && u.owner === 1 && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
    const onFriendlyCity = tile.type === 'city' && tile.city && tile.city.owner === 1;
    if (onCarrier || onFriendlyCity) continue;
    unit.fuel = Math.max(0, unit.fuel - 1);
    if (unit.fuel <= 0) {
      state.units = state.units.filter(u => u.id !== unit.id);
      io.to(state.roomCode).emit('battleReport', {
        attackerType: unit.type, attackerOwner: unit.owner,
        defenderType: null, defenderOwner: null,
        outcome: 'fuel_crash', location: { x: unit.x, y: unit.y }
      });
    }
  }

  checkWin(state);
  broadcastToPlayer(state, 1);
}

// ── AI (computer player 2) ────────────────────────────────────────────────
function scheduleAI(state) {
  if (state.aiPending) return;
  state.aiPending = true;
  setTimeout(() => {
    state.aiPending = false;
    runAILevel3(state);
  }, 800);
}

function broadcastToPlayer(state, pid) {
  const sock = state.playerSockets[pid];
  if (sock) sock.emit('stateUpdate', buildClientState(state, pid));
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

function findNearestUnit(state, unit, targetOwner) {
  let best = null, bestDist = Infinity;
  for (const u of state.units) {
    if (u.owner !== targetOwner) continue;
    const dist = hexDistance(unit.x, unit.y, u.x, u.y);
    if (dist < bestDist) { bestDist = dist; best = u; }
  }
  return best;
}

function getValidMoves(state, unit, def) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  return hexNeighbors(unit.x, unit.y, mapW, mapH)
    .filter(p => {
      const tile = state.tiles[p.y][p.x];
      if (tile.type === 'void') return false;
      if (!checkMoveDomain(def.domain, tile.type, tile)) return false;
      // Check stacking limit for AI moves
      if (getTileUnitCount(state, p.x, p.y) >= 2) {
        const enemies = state.units.filter(u => u.owner !== unit.owner && u.x === p.x && u.y === p.y);
        if (enemies.length === 0) return false; // full and no enemies to attack
      }
      return true;
    });
}

function getPathStep(state, unit, def, target) {
  const valid = getValidMoves(state, unit, def);
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const da = hexDistance(a.x, a.y, target.x, target.y);
    const db = hexDistance(b.x, b.y, target.x, target.y);
    return da - db;
  });
  return valid[0];
}

function doMove(state, unit, toX, toY) {
  const mapW = state.mapW || MAP_W;
  const mapH = state.mapH || MAP_H;
  if (toX < 0 || toX >= mapW || toY < 0 || toY >= mapH) return;
  const destTile = state.tiles[toY][toX];
  const def = UNIT_DEFS[unit.type];
  if (destTile.type === 'void') return;
  if (!checkMoveDomain(def.domain, destTile.type, destTile)) return;

  const enemies = state.units.filter(u => u.owner !== unit.owner && u.x === toX && u.y === toY);
  if (enemies.length === 0) {
    // Check stacking limit before moving (no combat)
    if (getTileUnitCount(state, toX, toY) >= 2) return;
  }

  for (const enemy of enemies) {
    const survivor = resolveCombat(state, unit, enemy);
    if (!survivor || survivor.id !== unit.id) {
      return; // unit lost or both survived but unit not present after combat
    }
    // If both survive, unit doesn't actually advance this step
    const stillExists = state.units.find(u => u.id === unit.id);
    const enemyStillExists = state.units.find(u => u.id === enemy.id);
    if (stillExists && enemyStillExists) return; // both survived, blocked
    if (!stillExists) return; // unit destroyed
  }

  // Air units cannot land on enemy cities — they can attack units there but must stay airborne
  const isEnemyCity = destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner && destTile.city.owner !== 0;
  if (def.domain === 'air' && isEnemyCity) {
    // Unit attacked any enemy units here (already resolved above) but cannot occupy the tile
    // Consume a move but don't actually land
    unit.movesLeft = Math.max(0, unit.movesLeft - 1);
    if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
    return;
  }

  unit.x = toX;
  unit.y = toY;
  unit.movesLeft = Math.max(0, unit.movesLeft - 1);

  if (destTile.type === 'city' && destTile.city && destTile.city.owner !== unit.owner) {
    if (def && def.canCapture) {
      destTile.city.owner = unit.owner;
      destTile.city.production = 'army'; // default infantry on capture
      destTile.city.progress = 0;
      state.units = state.units.filter(u => u.id !== unit.id);
      return;
    }
  }
  // Refuel air units when they land on a friendly city or a friendly carrier
  if (unit.fuel !== null) {
    const onFriendlyCity = destTile.type === 'city' && destTile.city && destTile.city.owner === unit.owner;
    const onFriendlyCarrier = state.units.some(u => u !== unit && u.owner === unit.owner && u.type === 'carrier' && u.x === toX && u.y === toY);
    if (onFriendlyCity || onFriendlyCarrier) {
      unit.fuel = UNIT_DEFS[unit.type].fuel;
    }
  }
}

// ── Transport capacity helper ──────────────────────────────────────────────
function getTransportUsedSlots(transport) {
  let used = 0;
  for (const cargo of transport.cargo) {
    const cDef = UNIT_DEFS[cargo.type];
    used += (cDef ? (cDef.slots || 1) : 1);
  }
  return used;
}

// ── Movement domain check ──────────────────────────────────────────────────
function checkMoveDomain(domain, tileType, tile) {
  if (domain === 'air') return true;
  // Fog tiles are unknown terrain — allow movement attempt; path will stop when it hits solid land/void
  if (tileType === 'fog') return true;
  if (domain === 'land') return tileType === 'land' || tileType === 'city';
  if (domain === 'sea') {
    if (tileType === 'ocean') return true;
    if (tileType === 'city' && tile && tile.city && tile.city.coastal) return true;
    return false;
  }
  return false;
}

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('createGame', ({ name, mapSize }) => {
    const code = generateRoomCode();
    const state = createGameState(code, mapSize);
    games.set(code, state);
    state.players[socket.id] = { id: 1, name: name || 'Player 1' };
    state.playerSockets[1] = socket;
    socket.join(code);
    socket.emit('gameCreated', { roomCode: code, playerNum: 1 });
    console.log('Game created', code, 'size:', mapSize || 'large');
  });

  socket.on('createSoloGame', ({ name, mapSize }) => {
    const code = generateRoomCode();
    const state = createGameState(code, mapSize);
    state.vsComputer = true;
    games.set(code, state);
    state.players[socket.id] = { id: 1, name: name || 'Player 1' };
    state.playerSockets[1] = socket;
    state.players['computer'] = { id: 2, name: 'Computer' };
    state.playerSockets[2] = null;
    socket.join(code);
    state.phase = 'playing';
    state.turnDeadline = Date.now() + TURN_SECONDS * 1000;
    state.turnTimer = setTimeout(() => {
      advanceTurn(state);
      broadcastToPlayer(state, 1);
      if (state.vsComputer) scheduleAI(state);
    }, TURN_SECONDS * 1000);
    socket.emit('gameJoined', { roomCode: code, playerNum: 1, vsComputer: true });
    socket.emit('stateUpdate', buildClientState(state, 1));
    console.log('Solo game started', code, 'size:', mapSize || 'large');
  });

  socket.on('joinGame', ({ roomCode, name }) => {
    const code = roomCode.toUpperCase().trim();
    const state = games.get(code);
    if (!state) return socket.emit('error', 'Room not found');

    // Solo games: treat joinGame as a rejoin for player 1
    if (state.vsComputer) {
      const p1Entry = Object.entries(state.players).find(([, p]) => p.id === 1);
      if (p1Entry) {
        const [oldSid, playerData] = p1Entry;
        delete state.players[oldSid];
        state.players[socket.id] = playerData;
      } else {
        state.players[socket.id] = { id: 1, name: name || 'Player 1' };
      }
      state.playerSockets[1] = socket;
      socket.join(code);
      socket.emit('gameJoined', { roomCode: code, playerNum: 1 });
      socket.emit('stateUpdate', buildClientState(state, 1));
      return;
    }

    const humanPlayers = Object.entries(state.players).filter(([k]) => k !== 'computer');

    if (state.phase === 'playing' && humanPlayers.length >= 2) {
      return socket.emit('error', 'Game is full');
    }

    if (state.phase === 'playing' && !state.playerSockets[2]) {
      state.players[socket.id] = { id: 2, name: name || 'Player 2' };
      state.playerSockets[2] = socket;
      socket.join(code);
      socket.emit('gameJoined', { roomCode: code, playerNum: 2 });
      broadcastState(state);
      console.log('Player 2 reconnected', code);
      return;
    }

    if (state.phase !== 'waiting') return socket.emit('error', 'Game already started');
    if (humanPlayers.length >= 2) return socket.emit('error', 'Room full');

    state.players[socket.id] = { id: 2, name: name || 'Player 2' };
    state.playerSockets[2] = socket;
    socket.join(code);

    state.phase = 'playing';
    state.turnDeadline = Date.now() + TURN_SECONDS * 1000;
    state.turnTimer = setTimeout(() => {
      advanceTurn(state);
      broadcastState(state);
    }, TURN_SECONDS * 1000);

    socket.emit('gameJoined', { roomCode: code, playerNum: 2 });
    broadcastState(state);
    console.log('Game started', code);
  });

  socket.on('moveUnit', ({ roomCode, unitId, toX, toY }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;
    const pnum = player.id;
    const mapW = state.mapW || MAP_W;
    const mapH = state.mapH || MAP_H;

    if (!state.vsComputer && state.activePlayer !== pnum) {
      return socket.emit('moveError', "It's not your turn");
    }

    const unit = state.units.find(u => u.id === unitId && u.owner === pnum);
    if (!unit) return;
    if (unit.movesLeft <= 0) return socket.emit('moveError', 'No movement points left');

    // Air units with 0 fuel cannot move — crash them immediately
    if (unit.fuel !== null && unit.fuel <= 0) {
      const crashTile = state.tiles[unit.y][unit.x];
      const onCarrier = state.units.some(u => u !== unit && u.owner === pnum && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
      const onFriendlyCity = crashTile.type === 'city' && crashTile.city && crashTile.city.owner === pnum;
      if (!onCarrier && !onFriendlyCity) {
        // Crash — remove unit
        state.units = state.units.filter(u => u.id !== unitId);
        broadcastState(state);
      }
      return socket.emit('moveError', 'Out of fuel — unit cannot move');
    }

    if (toX < 0 || toX >= mapW || toY < 0 || toY >= mapH) return;

    const destTile = state.tiles[toY][toX];
    const def = UNIT_DEFS[unit.type];

    // Reject void tiles
    if (destTile.type === 'void') return socket.emit('moveError', 'Cannot move there');

    const canMove = checkMoveDomain(def.domain, destTile.type, destTile);
    if (!canMove) return socket.emit('moveError', 'Invalid move for unit type');

    // Check stacking limit at destination (only if no enemies to fight)
    const enemiesAtDest = state.units.filter(u => u.owner !== pnum && u.x === toX && u.y === toY);
    if (enemiesAtDest.length === 0) {
      const countAtDest = getTileUnitCount(state, toX, toY);
      if (countAtDest >= 2) return socket.emit('moveError', 'Hex is full');
    }

    const dist = hexDistance(unit.x, unit.y, toX, toY);
    if (dist > unit.movesLeft) return socket.emit('moveError', 'Too far to move');

    const neighborCheck = hexNeighbors(unit.x, unit.y, mapW, mapH);
    const isAdjacentHex = neighborCheck.some(n => n.x === toX && n.y === toY);
    if (!isAdjacentHex && dist > 1) {
      // Multi-step pathfinding
      let current = unit;
      let steps = Math.min(dist, unit.movesLeft);
      for (let i = 0; i < steps && (current.x !== toX || current.y !== toY); i++) {
        const step = getPathStep(state, current, def, { x: toX, y: toY });
        if (!step) break;
        const stepTile = state.tiles[step.y][step.x];
        if (stepTile.type === 'void') break;

        // Fog-of-war stop: if this tile is unexplored and impassable, stop without attacking
        const explored = state.exploredTiles && state.exploredTiles[pnum];
        const tileExplored = !explored || explored.has(step.y * mapW + step.x);
        if (!checkMoveDomain(def.domain, stepTile.type, stepTile)) {
          // Hit impassable terrain — stop here without consuming moves, keep unit where it is
          broadcastState(state);
          socket.emit('moveBlocked', { unitId, stoppedAt: { x: current.x, y: current.y }, reason: 'terrain' });
          return;
        }

        // Check stacking at each intermediate step
        const stepEnemies = state.units.filter(u => u.owner !== pnum && u.x === step.x && u.y === step.y);
        if (stepEnemies.length === 0 && getTileUnitCount(state, step.x, step.y) >= 2) break;

        // Fog-of-war enemy encounter: if tile was unexplored, stop WITHOUT attacking — player must confirm
        if (stepEnemies.length > 0 && !tileExplored) {
          // Move unit to the tile just before the enemy, keep selected
          broadcastState(state);
          socket.emit('moveBlocked', { unitId, stoppedAt: { x: current.x, y: current.y }, reason: 'fog_enemy' });
          return;
        }

        const enemies = state.units.filter(u => u.owner !== pnum && u.x === step.x && u.y === step.y);
        let unitSurvived = true;
        if (enemies.length > 0) {
          for (const enemy of enemies) {
            const survivor = resolveCombat(state, current, enemy);
            if (!survivor) { unitSurvived = false; break; }
          }
          if (!unitSurvived) { broadcastState(state); return; }
          // If any enemy still occupies this tile (both missed / defender won), attacker cannot enter — stop here
          const remainingEnemies = state.units.filter(u => u.owner !== pnum && u.x === step.x && u.y === step.y);
          if (remainingEnemies.length > 0) { broadcastState(state); return; }
        }
        current.x = step.x;
        current.y = step.y;
        current.movesLeft = Math.max(0, current.movesLeft - 1);
        if (current.fuel !== null) current.fuel = Math.max(0, current.fuel - 1);

        // Reveal intermediate tiles as the unit passes through them
        if (state.exploredTiles && state.exploredTiles[pnum]) {
          const revealRange = 2;
          const revealQueue = [[step.x, step.y, 0]];
          const revealSeen = new Set([step.y * mapW + step.x]);
          while (revealQueue.length) {
            const [rx, ry, rd] = revealQueue.shift();
            state.exploredTiles[pnum].add(ry * mapW + rx);
            if (rd >= revealRange) continue;
            for (const nb of hexNeighbors(rx, ry, mapW, mapH)) {
              if (state.tiles[nb.y][nb.x].type === 'void') continue;
              const nk = nb.y * mapW + nb.x;
              if (!revealSeen.has(nk)) { revealSeen.add(nk); revealQueue.push([nb.x, nb.y, rd + 1]); }
            }
          }
        }
      }
    } else {
      // Single adjacent step — re-check actual tile domain (fog may resolve to impassable terrain)
      if (!checkMoveDomain(def.domain, destTile.type, destTile)) {
        // Tile revealed as impassable — unit stays put, no moves consumed
        broadcastState(state);
        return;
      }

      const enemyUnits = state.units.filter(u => u.owner !== pnum && u.x === toX && u.y === toY);
      if (enemyUnits.length > 0) {
        const enemy = enemyUnits[0];
        const survivor = resolveCombat(state, unit, enemy);
        if (!survivor) { broadcastState(state); return; }
        // If enemy still alive after combat (both missed / defender won), attacker cannot enter the tile
        const stillThere = state.units.some(u => u.owner !== pnum && u.x === toX && u.y === toY);
        if (stillThere) { broadcastState(state); return; }
      }

      unit.x = toX;
      unit.y = toY;
      unit.movesLeft = Math.max(0, unit.movesLeft - 1);
      if (unit.fuel !== null) unit.fuel = Math.max(0, unit.fuel - 1);
    }

    const movedUnit = state.units.find(u => u.id === unitId);
    if (movedUnit) {
      const newTile = state.tiles[movedUnit.y][movedUnit.x];

      // Refuel check: friendly city or carrier
      if (movedUnit.fuel !== null) {
        const onFriendlyCarrier = state.units.some(u => u !== movedUnit && u.owner === pnum && u.type === 'carrier' && u.x === movedUnit.x && u.y === movedUnit.y);
        const onFriendlyCity = newTile.type === 'city' && newTile.city && newTile.city.owner === pnum;
        if (onFriendlyCity || onFriendlyCarrier) {
          movedUnit.fuel = UNIT_DEFS[movedUnit.type].fuel;
        } else if (movedUnit.fuel <= 0) {
          // Out of fuel with no safe landing — crash immediately
          state.units = state.units.filter(u => u.id !== movedUnit.id);
          io.to(state.roomCode).emit('battleReport', {
            attackerType: movedUnit.type, attackerOwner: movedUnit.owner,
            defenderType: null, defenderOwner: null,
            outcome: 'fuel_crash', location: { x: movedUnit.x, y: movedUnit.y }
          });
          checkWin(state);
          broadcastState(state);
          return;
        }
      }

      if (newTile.type === 'city' && newTile.city) {
        const capDef = UNIT_DEFS[movedUnit.type];
        if (capDef && capDef.canCapture && newTile.city.owner !== pnum) {
          newTile.city.owner = pnum;
          newTile.city.production = 'army';
          newTile.city.progress = 0;
          state.units = state.units.filter(u => u.id !== movedUnit.id);
          checkWin(state);
          broadcastState(state);
          return;
        }
      }

      if (def.domain === 'land') {
        const friendlyTransport = state.units.find(u =>
          u.owner === pnum && u.type === 'transport' && u.x === movedUnit.x && u.y === movedUnit.y && u.id !== movedUnit.id
        );
        if (friendlyTransport) {
          socket.emit('boardingOpportunity', { transportId: friendlyTransport.id, unitId: movedUnit.id });
        }
      }
    }

    broadcastState(state);
  });

  // ── Transport: Load ────────────────────────────────────────────────────────
  socket.on('loadUnit', ({ roomCode, transportId, unitId }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;
    const pnum = player.id;

    const transport = state.units.find(u => u.id === transportId && u.owner === pnum && u.type === 'transport');
    if (!transport) return socket.emit('moveError', 'Transport not found');

    const landUnit = state.units.find(u => u.id === unitId && u.owner === pnum);
    if (!landUnit) return socket.emit('moveError', 'Unit not found');

    // Allow boarding from same tile OR any adjacent hex
    const onSameTile = landUnit.x === transport.x && landUnit.y === transport.y;
    const neighbors = hexNeighbors(transport.x, transport.y, state.mapW || MAP_W, state.mapH || MAP_H);
    const isAdjacent = neighbors.some(n => n.x === landUnit.x && n.y === landUnit.y);
    if (!onSameTile && !isAdjacent)
      return socket.emit('moveError', 'Unit must be adjacent to transport to board');
    // Check unit has movement left to board (costs 1 move if adjacent)
    if (!onSameTile && landUnit.movesLeft <= 0)
      return socket.emit('moveError', 'Unit has no movement left to board');
    // Move unit to transport tile if adjacent
    if (!onSameTile) {
      landUnit.x = transport.x;
      landUnit.y = transport.y;
      landUnit.movesLeft = Math.max(0, landUnit.movesLeft - 1);
    }

    const transDef = UNIT_DEFS[landUnit.type];
    if (!transDef || transDef.domain !== 'land')
      return socket.emit('moveError', 'Only land units can be loaded onto transport');

    const transportDef = UNIT_DEFS['transport'];
    const usedSlots = getTransportUsedSlots(transport);
    const unitSlots = transDef.slots || 1;
    if (usedSlots + unitSlots > transportDef.capacity)
      return socket.emit('moveError', 'Transport is full (max: 1 infantry + 1 tank, or 3 infantry)');

    state.units = state.units.filter(u => u.id !== unitId);
    transport.cargo.push({ ...landUnit });

    broadcastState(state);
  });

  // ── Transport: Unload ──────────────────────────────────────────────────────
  socket.on('unloadUnit', ({ roomCode, transportId, cargoIndex, toX, toY }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;
    const pnum = player.id;
    const mapW = state.mapW || MAP_W;
    const mapH = state.mapH || MAP_H;

    const transport = state.units.find(u => u.id === transportId && u.owner === pnum && u.type === 'transport');
    if (!transport) return socket.emit('moveError', 'Transport not found');
    if (!transport.cargo || transport.cargo.length === 0)
      return socket.emit('moveError', 'Transport has no cargo');
    if (cargoIndex < 0 || cargoIndex >= transport.cargo.length)
      return socket.emit('moveError', 'Invalid cargo index');

    const neighbors = hexNeighbors(transport.x, transport.y, mapW, mapH);
    const isAdj = neighbors.some(n => n.x === toX && n.y === toY);
    if (!isAdj) return socket.emit('moveError', 'Unload target must be adjacent to transport');

    const destTile = state.tiles[toY] && state.tiles[toY][toX];
    if (!destTile || (destTile.type !== 'land' && destTile.type !== 'city'))
      return socket.emit('moveError', 'Can only unload onto land');

    // Check stacking limit for unload target
    if (getTileUnitCount(state, toX, toY) >= 2)
      return socket.emit('moveError', 'Hex is full');

    const cargoUnit = transport.cargo.splice(cargoIndex, 1)[0];
    cargoUnit.x = toX;
    cargoUnit.y = toY;
    cargoUnit.movesLeft = UNIT_DEFS[cargoUnit.type].move;
    cargoUnit.id = newUid();

    // City capture: if unloaded unit can capture and lands on enemy/neutral city
    const cargoDef = UNIT_DEFS[cargoUnit.type];
    if (cargoDef && cargoDef.canCapture && destTile.type === 'city' && destTile.city && destTile.city.owner !== pnum) {
      destTile.city.owner = pnum;
      destTile.city.production = 'army'; // default to infantry on capture
      destTile.city.progress = 0;
      // Unit is consumed by the capture (A&A style) — do NOT push to board
    } else {
      state.units.push(cargoUnit);
    }

    broadcastState(state);
  });

  socket.on('setProduction', ({ roomCode, cityX, cityY, unitType }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;

    const tile = state.tiles[cityY][cityX];
    if (!tile || tile.type !== 'city' || !tile.city) return;
    if (tile.city.owner !== player.id) return;
    if (!UNIT_DEFS[unitType]) return;

    const navalTypes = ['destroyer','submarine','transport','carrier','battleship'];
    if (navalTypes.includes(unitType) && !tile.city.coastal) {
      return socket.emit('moveError', 'Only coastal cities can build naval units');
    }

    // Only reset progress if actually changing production type
    if (tile.city.production !== unitType) {
      tile.city.production = unitType;
      tile.city.progress = 0;
    }
    broadcastState(state);
  });

  // iOS/mobile: browser drops WebSocket when screen locks or app backgrounds.
  // On resume, client calls rejoinGame to re-associate this socket and get fresh state.
  socket.on('rejoinGame', ({ roomCode, name, playerNum }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const state = games.get(code);
    if (!state) return;

    // Match by playerNum first (most reliable), then fall back to name
    let pid = null;
    if (playerNum && (playerNum === 1 || playerNum === 2)) {
      pid = playerNum;
    } else {
      for (const [, p] of Object.entries(state.players)) {
        if (p.name === name) { pid = p.id; break; }
      }
    }
    if (!pid) return;

    // Re-register socket — update players map with new socket id
    const oldEntry = Object.entries(state.players).find(([, p]) => p.id === pid);
    if (oldEntry) {
      const [oldSid, playerData] = oldEntry;
      delete state.players[oldSid];
      state.players[socket.id] = playerData;
    } else {
      state.players[socket.id] = { id: pid, name: name || ('Player ' + pid) };
    }
    state.playerSockets[pid] = socket;
    socket.join(code);
    socket.emit('stateUpdate', buildClientState(state, pid));
    console.log(`Player ${pid} rejoined ${code} (screen wake/app resume)`);
  });

  // ── Attack adjacent enemy (even with 0 moves left) ────────────────────────
  socket.on('attackUnit', ({ roomCode, attackerId, defenderX, defenderY }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;
    const pnum = player.id;
    if (!state.vsComputer && state.activePlayer !== pnum) return;

    const attacker = state.units.find(u => u.id === attackerId && u.owner === pnum);
    if (!attacker) return;

    // Unit must have started the turn (i.e. has attacked = false, or no hasAttacked flag)
    // We track hasAttacked per unit — if already attacked this turn, deny.
    if (attacker.hasAttacked) return socket.emit('moveError', 'Unit already attacked this turn');

    // Defender must be adjacent
    const neighbors = hexNeighbors(attacker.x, attacker.y, state.mapW || MAP_W, state.mapH || MAP_H);
    const isAdj = neighbors.some(n => n.x === defenderX && n.y === defenderY);
    if (!isAdj) return socket.emit('moveError', 'Target not adjacent');

    // Defender must be an enemy
    const defenders = state.units.filter(u => u.owner !== pnum && u.x === defenderX && u.y === defenderY);
    if (defenders.length === 0) return socket.emit('moveError', 'No enemy at target');

    const defender = defenders[0];

    // Resolve combat — attacker stays in place regardless of outcome
    resolveCombat(state, attacker, defender);

    // Mark unit as having attacked this turn; air units burn 1 fuel per attack
    const stillAlive = state.units.find(u => u.id === attackerId);
    if (stillAlive) {
      stillAlive.hasAttacked = true;
      if (stillAlive.fuel !== null) {
        stillAlive.fuel = Math.max(0, stillAlive.fuel - 1);
        // Crash if out of fuel with no safe landing
        const curTile = state.tiles[stillAlive.y][stillAlive.x];
        const onCarrier = state.units.some(u => u !== stillAlive && u.owner === pnum && u.type === 'carrier' && u.x === stillAlive.x && u.y === stillAlive.y);
        const onFriendlyCity = curTile.type === 'city' && curTile.city && curTile.city.owner === pnum;
        if (stillAlive.fuel <= 0 && !onCarrier && !onFriendlyCity) {
          state.units = state.units.filter(u => u.id !== stillAlive.id);
          io.to(state.roomCode).emit('battleReport', {
            attackerType: stillAlive.type, attackerOwner: stillAlive.owner,
            defenderType: null, defenderOwner: null,
            outcome: 'fuel_crash', location: { x: stillAlive.x, y: stillAlive.y }
          });
        }
      }
    }

    checkWin(state);
    broadcastState(state);
  });

  socket.on('endTurn', ({ roomCode }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;
    const pnum = player.id;

    if (state.vsComputer) {
      if (pnum !== 1) return;
      // Flip to AI's turn so player sees "Opponent's Turn" while AI thinks
      state.activePlayer = 2;
      state.turnEnded[1] = true;
      broadcastToPlayer(state, 1);
      scheduleAI(state);
    } else {
      if (pnum !== state.activePlayer) return;
      clearTimeout(state.turnTimer);
      advanceTurn(state);
      broadcastState(state);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    for (const [code, state] of games.entries()) {
      if (state.players[socket.id]) {
        const pid = state.players[socket.id].id;
        delete state.players[socket.id];
        state.playerSockets[pid] = null;
        const otherPid = pid === 1 ? 2 : 1;
        const otherSock = state.playerSockets[otherPid];
        if (otherSock) otherSock.emit('opponentDisconnected');
        break;
      }
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Strategic Conquest server running on port ${PORT}`);
});
