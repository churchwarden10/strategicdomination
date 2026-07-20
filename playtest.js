/**
 * playtest.js — Automated AI vs AI playtester for StratCon
 * Usage: node playtest.js 2>&1 | tee /tmp/playtest.log
 */
'use strict';

const { io } = require('/home/node/.openclaw/workspace/stratcon/node_modules/socket.io-client');

const MAX_TURNS = 50;
const SERVER = 'http://localhost:3000';

function ts() { return new Date().toISOString().substr(11,8); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Hex neighbor helper ────────────────────────────────────────────────────
function hexNeighbors(col, row, mapW, mapH) {
  const EVEN = [[1,0],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1]];
  const ODD  = [[1,0],[1,-1],[0,-1],[-1,0],[0,1],[1,1]];
  const dirs = (row % 2 === 0) ? EVEN : ODD;
  const result = [];
  for (const [dc, dr] of dirs) {
    const nc = col + dc, nr = row + dr;
    if (nc >= 0 && nc < mapW && nr >= 0 && nr < mapH)
      result.push({ x: nc, y: nr });
  }
  return result;
}

// ── Domain movement check (mirrors server logic) ───────────────────────────
function domainOk(domain, tileType, tileCoastal) {
  if (domain === 'air') return tileType !== 'void' && tileType !== 'fog';
  if (domain === 'land') return tileType === 'land' || tileType === 'city';
  if (domain === 'sea') {
    if (tileType === 'ocean') return true;
    if (tileType === 'city' && tileCoastal) return true;
    return false;
  }
  return false;
}

const UNIT_DEFS = {
  army:       { move:1,  domain:'land'  },
  tank:       { move:2,  domain:'land'  },
  fighter:    { move:8,  domain:'air'   },
  helicopter: { move:4,  domain:'air'   },
  destroyer:  { move:4,  domain:'sea'   },
  submarine:  { move:3,  domain:'sea'   },
  transport:  { move:3,  domain:'sea'   },
  carrier:    { move:3,  domain:'sea'   },
  battleship: { move:3,  domain:'sea'   },
  bomber:     { move:6,  domain:'air'   },
};

function getValidNeighbors(state, unit) {
  const { mapW, mapH, tiles } = state;
  const def = UNIT_DEFS[unit.type];
  if (!def) return [];
  const neighbors = hexNeighbors(unit.x, unit.y, mapW, mapH);
  return neighbors.filter(n => {
    const row = tiles[n.y];
    if (!row) return false;
    const tile = row[n.x];
    if (!tile || tile.type === 'fog') return false;
    const coastal = tile.city ? tile.city.coastal : false;
    return domainOk(def.domain, tile.type, coastal);
  });
}

function countCities(state, player) {
  let count = 0;
  if (!state.tiles) return 0;
  for (const row of state.tiles)
    for (const t of row)
      if (t && t.type === 'city' && t.city && t.city.owner === player)
        count++;
  return count;
}

// ── Run one game ──────────────────────────────────────────────────────────
async function runGame(gameIndex) {
  log(`\n${'='.repeat(60)}\nGAME ${gameIndex+1} STARTING\n${'='.repeat(60)}`);

  const report = {
    gameIndex,
    turns: 0,
    winner: null,
    endReason: null,
    moveErrors: [],
    turnFlipBugs: [],
    stuckBugs: [],
    productionNotes: [],
    captureSeen: false,
    events: [],
  };

  function note(msg) {
    log(msg);
    report.events.push(msg);
  }

  return new Promise((resolve) => {
    const p1 = io(SERVER, { transports: ['websocket'] });
    const p2 = io(SERVER, { transports: ['websocket'] });

    let roomCode = null;
    let gameOver = false;

    // Per-player "my current state" — refreshed on each stateUpdate
    const myState = { 1: null, 2: null };

    // Serialised turn-processing lock
    let busy = false;

    // Turn tracking
    let lastTurn = 0;
    let lastActive = null;
    let consecutiveSameActive = 0;
    let stuckConsec = 0;

    let watchdog = null;
    function resetWatchdog() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish('WATCHDOG: no activity for 10s'), 10000);
    }

    function finish(reason) {
      if (gameOver) return;
      gameOver = true;
      report.endReason = reason;
      report.turns = lastTurn;
      clearTimeout(watchdog);
      p1.disconnect();
      p2.disconnect();
      note(`Game ${gameIndex+1} ended: ${reason}`);
      resolve(report);
    }

    // ── AI: move all own units then end turn ────────────────────────────────
    async function aiTurn(sock, state, playerNum) {
      if (gameOver) return;
      const roomC = roomCode;

      const myUnits = state.units.filter(u => u.owner === playerNum && u.movesLeft > 0);
      let movesMade = 0;
      let totalUnits = state.units.filter(u => u.owner === playerNum).length;

      for (const unit of myUnits) {
        const neighbors = getValidNeighbors(state, unit);
        if (neighbors.length === 0) continue;
        const dest = neighbors[Math.floor(Math.random() * neighbors.length)];
        sock.emit('moveUnit', { roomCode: roomC, unitId: unit.id, toX: dest.x, toY: dest.y });
        movesMade++;
        await sleep(30);
      }

      if (movesMade === 0 && totalUnits > 0) {
        stuckConsec++;
        if (stuckConsec >= 5) {
          const msg = `Player ${playerNum} stuck for ${stuckConsec} turns (0 valid moves for ${totalUnits} units)`;
          report.stuckBugs.push(`Turn ${lastTurn}: ${msg}`);
          note(`STUCK BUG: ${msg}`);
        }
      } else {
        stuckConsec = 0;
      }

      // Set production on any idle owned cities
      for (let y = 0; y < state.mapH; y++) {
        for (let x = 0; x < state.mapW; x++) {
          const tile = state.tiles[y][x];
          if (tile && tile.type === 'city' && tile.city && tile.city.owner === playerNum && !tile.city.production) {
            const types = ['army','army','tank','fighter','helicopter'];
            const unitType = types[Math.floor(Math.random() * types.length)];
            sock.emit('setProduction', { roomCode: roomC, cityX: x, cityY: y, unitType });
            report.productionNotes.push(`Turn ${lastTurn}: P${playerNum} set production to ${unitType} at (${x},${y})`);
            await sleep(20);
          }
        }
      }

      await sleep(100);
      sock.emit('endTurn', { roomCode: roomC });
    }

    // ── Handle incoming stateUpdate ─────────────────────────────────────────
    async function onState(playerNum, state) {
      if (gameOver) return;
      myState[playerNum] = state;

      resetWatchdog();

      // Game ended?
      if (state.phase === 'ended' || state.winner) {
        report.winner = state.winner;
        finish(`Winner: Player ${state.winner}`);
        return;
      }

      if (state.phase !== 'playing') return;

      // Only the active player's socket should drive moves
      if (state.activePlayer !== playerNum) return;

      // Don't overlap turns
      if (busy) return;
      busy = true;

      const turn = state.turn;

      // Check turn flip
      if (lastActive !== null && lastActive === state.activePlayer && turn === lastTurn) {
        consecutiveSameActive++;
        if (consecutiveSameActive >= 2) {
          const msg = `Turn ${turn}: activePlayer stuck at ${state.activePlayer} (${consecutiveSameActive} times)`;
          report.turnFlipBugs.push(msg);
          note(`TURN FLIP BUG: ${msg}`);
        }
      } else {
        consecutiveSameActive = 0;
      }
      lastActive = state.activePlayer;
      lastTurn   = turn;

      // Stop at max turns
      if (turn > MAX_TURNS) {
        finish(`Max turns (${MAX_TURNS}) reached`);
        busy = false;
        return;
      }

      const p1c = countCities(state, 1);
      const p2c = countCities(state, 2);
      const p1u = state.units.filter(u => u.owner === 1).length;
      const p2u = state.units.filter(u => u.owner === 2).length;

      note(`Turn ${turn} | P${state.activePlayer} | Cities: P1=${p1c} P2=${p2c} | Units: P1=${p1u} P2=${p2u}`);

      const sock = playerNum === 1 ? p1 : p2;
      await aiTurn(sock, state, playerNum);

      busy = false;
    }

    // ── Wire P1 ─────────────────────────────────────────────────────────────
    p1.on('connect', () => note('P1 connected'));
    p1.on('gameCreated', ({ roomCode: code, playerNum }) => {
      roomCode = code;
      note(`Game created: ${code} (P1=player${playerNum})`);
      p2.emit('joinGame', { roomCode: code, name: 'AI-Blue' });
    });
    p1.on('stateUpdate', s => onState(1, s));
    p1.on('moveError',   msg => {
      const e = `P1 moveError @ turn ${lastTurn}: ${msg}`;
      report.moveErrors.push(e);
      note(`ERROR: ${e}`);
    });
    p1.on('boardingOpportunity', () => {}); // ignore

    // ── Wire P2 ─────────────────────────────────────────────────────────────
    p2.on('connect', () => note('P2 connected'));
    p2.on('gameJoined', ({ roomCode: code }) => note(`P2 joined room ${code}`));
    p2.on('stateUpdate', s => onState(2, s));
    p2.on('moveError',   msg => {
      const e = `P2 moveError @ turn ${lastTurn}: ${msg}`;
      report.moveErrors.push(e);
      note(`ERROR: ${e}`);
    });
    p2.on('boardingOpportunity', () => {}); // ignore

    // ── Start ───────────────────────────────────────────────────────────────
    p1.on('connect', () => {
      p1.emit('createGame', { name: 'AI-Red', mapSize: 'small' });
    });

    resetWatchdog();

    // Connection timeout
    setTimeout(() => {
      if (!roomCode && !gameOver) finish('TIMEOUT: game never created/joined');
    }, 8000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const allReports = [];

  for (let i = 0; i < 3; i++) {
    const r = await runGame(i);
    allReports.push(r);
    log(`\n--- Game ${i+1} quick summary ---`);
    log(`  End: ${r.endReason}`);
    log(`  Turns: ${r.turns}, Winner: ${r.winner}`);
    log(`  Move errors: ${r.moveErrors.length}`);
    log(`  Turn-flip bugs: ${r.turnFlipBugs.length}`);
    log(`  Stuck bugs: ${r.stuckBugs.length}`);
    log(`  Production notes: ${r.productionNotes.length}`);
    if (i < 2) await sleep(1500);
  }

  // ── Final aggregate ──────────────────────────────────────────────────────
  log('\n' + '='.repeat(60));
  log('FULL BUG REPORT');
  log('='.repeat(60));

  for (const r of allReports) {
    log(`\n## Game ${r.gameIndex+1}`);
    log(`  End reason: ${r.endReason}`);
    log(`  Turns: ${r.turns}, Winner: ${r.winner}`);

    if (r.moveErrors.length) {
      log('  MOVE ERRORS:');
      r.moveErrors.forEach(e => log('    ' + e));
    }
    if (r.turnFlipBugs.length) {
      log('  TURN-FLIP BUGS:');
      r.turnFlipBugs.forEach(e => log('    ' + e));
    }
    if (r.stuckBugs.length) {
      log('  STUCK BUGS:');
      r.stuckBugs.forEach(e => log('    ' + e));
    }
    if (!r.moveErrors.length && !r.turnFlipBugs.length && !r.stuckBugs.length) {
      log('  ✅ No bugs detected');
    }
    if (r.productionNotes.length) {
      log(`  Production events: ${r.productionNotes.length} (first 3: ${r.productionNotes.slice(0,3).join('; ')})`);
    }
  }

  log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
