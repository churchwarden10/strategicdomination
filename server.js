const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ──────────────────────────────────────────────────────────────
const MAP_W = 40, MAP_H = 40;
const TURN_SECONDS = 30;

const UNIT_DEFS = {
  army:       { buildTime: 5,  move: 1,  domain: 'land',  fuel: null, carries: null,    symbol: '🪖' },
  fighter:    { buildTime: 3,  move: 8,  domain: 'air',   fuel: 20,   carries: null,    symbol: '✈️' },
  destroyer:  { buildTime: 6,  move: 4,  domain: 'sea',   fuel: null, carries: null,    symbol: '🚢' },
  submarine:  { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: null,    symbol: '🤿', hidden: true },
  transport:  { buildTime: 8,  move: 3,  domain: 'sea',   fuel: null, carries: 'army',  capacity: 6, symbol: '⛴️' },
  carrier:    { buildTime: 12, move: 3,  domain: 'sea',   fuel: null, carries: 'fighter', capacity: 8, symbol: '🛳️' },
  battleship: { buildTime: 14, move: 3,  domain: 'sea',   fuel: null, carries: null,    symbol: '⚓' },
  bomber:     { buildTime: 5,  move: 6,  domain: 'air',   fuel: 10,   carries: null,    symbol: '💣' },
};

// ── Map Generation ─────────────────────────────────────────────────────────
function generateMap() {
  const tiles = [];
  // Simple noise-based terrain using midpoint displacement concept
  const noise = [];
  for (let i = 0; i < MAP_W * MAP_H; i++) noise.push(Math.random());

  // Smooth the noise a bit (box blur passes)
  function idx(x, y) { return y * MAP_W + x; }
  const smoothed = noise.slice();
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H) {
              sum += smoothed[idx(nx, ny)]; count++;
            }
          }
        }
        smoothed[idx(x, y)] = sum / count;
      }
    }
  }

  // Threshold: bottom 70% → ocean, top 30% → land
  const sorted = smoothed.slice().sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.70)];

  for (let y = 0; y < MAP_H; y++) {
    tiles.push([]);
    for (let x = 0; x < MAP_W; x++) {
      const v = smoothed[idx(x, y)];
      tiles[y].push({ type: v >= threshold ? 'land' : 'ocean', owner: null, city: null });
    }
  }

  // Place ~20 cities on land tiles
  const landTiles = [];
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (tiles[y][x].type === 'land') landTiles.push([x, y]);

  shuffle(landTiles);
  const cityCount = Math.min(20, landTiles.length);
  const cities = [];
  const minDist = 4;

  for (let i = 0; i < landTiles.length && cities.length < cityCount; i++) {
    const [cx, cy] = landTiles[i];
    let tooClose = false;
    for (const [ex, ey] of cities) {
      if (Math.abs(cx - ex) + Math.abs(cy - ey) < minDist) { tooClose = true; break; }
    }
    if (!tooClose) {
      cities.push([cx, cy]);
      tiles[cy][cx].type = 'city';
      tiles[cy][cx].city = { owner: null, production: null, progress: 0, id: cities.length - 1 };
    }
  }

  // Ensure at least one land path near edges for player starts (best-effort)
  // Player 1 start city: top-left quadrant, Player 2: bottom-right
  let p1City = null, p2City = null;
  for (const [x, y] of cities) {
    if (!p1City && x < MAP_W / 2 && y < MAP_H / 2) p1City = [x, y];
    if (!p2City && x >= MAP_W / 2 && y >= MAP_H / 2) p2City = [x, y];
  }
  // Fallback
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

// ── Game State ─────────────────────────────────────────────────────────────
const games = new Map(); // roomCode → state
let uidCounter = 0;
function newUid() { return ++uidCounter; }

function createGameState(roomCode) {
  const mapData = generateMap();
  const { tiles, p1City, p2City } = mapData;

  // Assign starting cities
  tiles[p1City[1]][p1City[0]].city.owner = 1;
  tiles[p2City[1]][p2City[0]].city.owner = 2;

  const state = {
    roomCode,
    phase: 'waiting', // waiting | playing | ended
    players: {}, // socketId → { id: 1|2, name }
    playerSockets: [null, null, null], // index 1,2
    tiles,
    units: [], // { id, owner, type, x, y, movesLeft, fuel, cargo:[], id }
    turn: 1,
    turnEnded: [false, false, false], // index 1,2
    turnTimer: null,
    turnDeadline: null,
    winner: null,
  };

  // Place starting army at each city
  spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
  spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

  return state;
}

function spawnUnit(state, owner, type, x, y) {
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
  const visible = new Set();
  const range = 2;

  function reveal(cx, cy) {
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H)
          visible.add(ny * MAP_W + nx);
      }
    }
  }

  for (const unit of state.units) {
    if (unit.owner === playerNum) reveal(unit.x, unit.y);
  }
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = state.tiles[y][x];
      if (t.type === 'city' && t.city && t.city.owner === playerNum) reveal(x, y);
    }
  }
  return visible;
}

function buildClientState(state, playerNum) {
  const visible = getVisibleTiles(state, playerNum);

  // Filtered tiles
  const clientTiles = state.tiles.map((row, y) =>
    row.map((tile, x) => {
      const key = y * MAP_W + x;
      if (!visible.has(key)) return { type: 'fog' };
      const t = { type: tile.type };
      if (tile.city) {
        t.city = {
          owner: tile.city.owner,
          production: tile.city.production,
          progress: tile.city.progress,
          id: tile.city.id,
        };
      }
      return t;
    })
  );

  // Filtered units (hide enemy subs unless adjacent)
  const clientUnits = state.units
    .filter(u => {
      if (!visible.has(u.y * MAP_W + u.x)) return false;
      if (u.owner !== playerNum && UNIT_DEFS[u.type].hidden) {
        // Submarines only visible if player has a unit/city within 1 tile
        const adj = getVisibleTiles(state, playerNum);
        // Check if sub's tile is within range 1 of any own unit
        let found = false;
        for (const ou of state.units) {
          if (ou.owner === playerNum && Math.abs(ou.x - u.x) <= 1 && Math.abs(ou.y - u.y) <= 1) {
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
    winner: state.winner,
  };
}

// ── Combat ─────────────────────────────────────────────────────────────────
function resolveCombat(state, attacker, defender) {
  // 60% attacker wins
  if (Math.random() < 0.6) {
    // Attacker wins
    state.units = state.units.filter(u => u.id !== defender.id);
    return attacker;
  } else {
    // Defender wins
    state.units = state.units.filter(u => u.id !== attacker.id);
    return null;
  }
}

// ── Turn / Production ──────────────────────────────────────────────────────
function advanceTurn(state) {
  state.turn++;
  state.turnEnded[1] = false;
  state.turnEnded[2] = false;

  // Reset movement
  for (const unit of state.units) {
    unit.movesLeft = UNIT_DEFS[unit.type].move;
  }

  // Production tick
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const tile = state.tiles[y][x];
      if (tile.type !== 'city' || !tile.city) continue;
      const city = tile.city;
      if (!city.owner || !city.production) continue;
      city.progress++;
      if (city.progress >= UNIT_DEFS[city.production].buildTime) {
        spawnUnit(state, city.owner, city.production, x, y);
        city.progress = 0;
        // Keep producing same unit type
      }
    }
  }

  // Fuel burn for air units
  for (const unit of state.units) {
    if (unit.fuel !== null) {
      // Fuel decreases when unit moves; here we don't auto-deduct on turn just from passage
      // Fighters/Bombers over ocean die if no fuel or no carrier to land on
      if (unit.fuel <= 0) {
        // Check if on a city owned by player or a carrier
        const tile = state.tiles[unit.y][unit.x];
        const onFriendlyCity = tile.type === 'city' && tile.city && tile.city.owner === unit.owner;
        const onCarrier = state.units.some(u => u !== unit && u.owner === unit.owner && u.type === 'carrier' && u.x === unit.x && u.y === unit.y);
        if (!onFriendlyCity && !onCarrier) {
          state.units = state.units.filter(u => u.id !== unit.id);
        } else {
          unit.fuel = UNIT_DEFS[unit.type].fuel; // refuel
        }
      }
    }
  }

  // Check win condition
  checkWin(state);

  // Set new deadline
  state.turnDeadline = Date.now() + TURN_SECONDS * 1000;

  // Reset turn timer
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

  if (p2Cities === 0 && p2Units === 0) {
    state.winner = 1;
    state.phase = 'ended';
    clearTimeout(state.turnTimer);
  } else if (p1Cities === 0 && p1Units === 0) {
    state.winner = 2;
    state.phase = 'ended';
    clearTimeout(state.turnTimer);
  }
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

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('createGame', ({ name }) => {
    const code = generateRoomCode();
    const state = createGameState(code);
    games.set(code, state);
    state.players[socket.id] = { id: 1, name: name || 'Player 1' };
    state.playerSockets[1] = socket;
    socket.join(code);
    socket.emit('gameCreated', { roomCode: code, playerNum: 1 });
    console.log('Game created', code);
  });

  socket.on('joinGame', ({ roomCode, name }) => {
    const code = roomCode.toUpperCase().trim();
    const state = games.get(code);
    if (!state) return socket.emit('error', 'Room not found');
    if (state.phase !== 'waiting') return socket.emit('error', 'Game already started');
    if (Object.keys(state.players).length >= 2) return socket.emit('error', 'Room full');

    state.players[socket.id] = { id: 2, name: name || 'Player 2' };
    state.playerSockets[2] = socket;
    socket.join(code);

    // Start game
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

    const unit = state.units.find(u => u.id === unitId && u.owner === pnum);
    if (!unit) return;
    if (unit.movesLeft <= 0) return socket.emit('moveError', 'No movement points left');

    // Validate destination
    if (toX < 0 || toX >= MAP_W || toY < 0 || toY >= MAP_H) return;

    const destTile = state.tiles[toY][toX];
    const def = UNIT_DEFS[unit.type];

    // Domain check
    const canMove = checkMoveDomain(def.domain, destTile.type);
    if (!canMove) return socket.emit('moveError', 'Invalid move for unit type');

    // Range check: movement is step-by-step, but we allow clicking destination and compute steps
    // Simple: just require Manhattan distance ≤ movesLeft for now (path not computed)
    const dist = Math.max(Math.abs(toX - unit.x), Math.abs(toY - unit.y)); // Chebyshev
    if (dist > unit.movesLeft) return socket.emit('moveError', 'Too far to move');

    // Combat check
    const enemyUnits = state.units.filter(u => u.owner !== pnum && u.x === toX && u.y === toY);
    if (enemyUnits.length > 0) {
      const enemy = enemyUnits[0];
      const survivor = resolveCombat(state, unit, enemy);
      if (!survivor) {
        // Attacker lost
        broadcastState(state);
        return;
      }
    }

    // Move
    const moveCost = dist;
    unit.x = toX;
    unit.y = toY;
    unit.movesLeft -= moveCost;
    if (unit.movesLeft < 0) unit.movesLeft = 0;

    // Fuel burn for air units
    if (unit.fuel !== null) {
      unit.fuel -= moveCost;
      if (unit.fuel < 0) unit.fuel = 0;
    }

    // City capture
    if (destTile.type === 'city' && destTile.city) {
      if (unit.type === 'army') {
        const prevOwner = destTile.city.owner;
        destTile.city.owner = pnum;
        if (!destTile.city.production) destTile.city.production = 'army';
        // Reset production if captured
        if (prevOwner !== pnum) destTile.city.progress = 0;
        checkWin(state);
      }
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

    tile.city.production = unitType;
    tile.city.progress = 0;
    broadcastState(state);
  });

  socket.on('endTurn', ({ roomCode }) => {
    const state = games.get(roomCode);
    if (!state || state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player) return;

    state.turnEnded[player.id] = true;

    if (state.turnEnded[1] && state.turnEnded[2]) {
      clearTimeout(state.turnTimer);
      advanceTurn(state);
      broadcastState(state);
    } else {
      broadcastState(state);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // Find game and notify other player
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

function checkMoveDomain(domain, tileType) {
  if (domain === 'air') return true; // air units go anywhere
  if (domain === 'land') return tileType === 'land' || tileType === 'city';
  if (domain === 'sea') return tileType === 'ocean';
  return false;
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Strategic Conquest server running on http://localhost:${PORT}`);
});
