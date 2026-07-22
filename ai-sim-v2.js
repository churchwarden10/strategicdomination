/**
 * ai-sim-v2.js — AI v2 (runAILevel3 from server.js) headless simulation
 * Runs 5 AI vs AI games and reports stats.
 */

'use strict';

const MAP_W = 20, MAP_H = 20;
const MAX_TURNS = 300;
const NUM_GAMES = 5;

const UNIT_DEFS = {
  army:       { buildTime: 1,  move: 1,  domain: 'land', fuel: null, carries: null,      canCapture: true,  slots: 1,  maxHp: 3  },
  tank:       { buildTime: 2,  move: 2,  domain: 'land', fuel: null, carries: null,      canCapture: true,  slots: 2,  maxHp: 6  },
  fighter:    { buildTime: 4,  move: 10, domain: 'air',  fuel: 10,   carries: null,      canCapture: false, slots: 0,  maxHp: 6  },
  bomber:     { buildTime: 5,  move: 15, domain: 'air',  fuel: 15,   carries: null,      canCapture: false, slots: 0,  maxHp: 8  },
  submarine:  { buildTime: 4,  move: 4,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, slots: 0,  maxHp: 4  },
  destroyer:  { buildTime: 4,  move: 4,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, slots: 0,  maxHp: 5  },
  transport:  { buildTime: 3,  move: 3,  domain: 'sea',  fuel: null, carries: 'army',    canCapture: false, capacity: 3, slots: 0, maxHp: 10 },
  carrier:    { buildTime: 8,  move: 3,  domain: 'sea',  fuel: null, carries: 'fighter', canCapture: false, capacity: 8, slots: 0, maxHp: 10 },
  battleship: { buildTime: 8,  move: 3,  domain: 'sea',  fuel: null, carries: null,      canCapture: false, slots: 0,  maxHp: 10 },
};

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

// ── Hex helpers ──────────────────────────────────────────────────────────
const HEX_NEIGHBORS_EVEN = [[1,0],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1]];
const HEX_NEIGHBORS_ODD  = [[1,0],[1,-1],[0,-1],[-1,0],[0,1],[1,1]];

function hexNeighbors(col, row, W, H) {
  const dirs = (row % 2 === 0) ? HEX_NEIGHBORS_EVEN : HEX_NEIGHBORS_ODD;
  return dirs.map(([dc, dr]) => ({ x: col+dc, y: row+dr }))
             .filter(({x,y}) => x>=0 && x<W && y>=0 && y<H);
}

function offsetToCube(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return { x, y: -x-z, z };
}

function hexDistance(c1,r1,c2,r2) {
  const a = offsetToCube(c1,r1), b = offsetToCube(c2,r2);
  return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.z-b.z));
}

function isInHexBounds(col, row, W, H) {
  const a = offsetToCube(col, row), b = offsetToCube(W/2, H/2);
  return Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.z-b.z)) <= Math.floor(W/2);
}

function shuffle(arr) {
  for (let i = arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Map generation ───────────────────────────────────────────────────────
function generateMap(W, H) {
  const noise = Array.from({length: W*H}, () => Math.random());
  const idx = (x,y) => y*W+x;
  const sm = noise.slice();
  for (let pass=0; pass<3; pass++) {
    for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
      let sum=0, cnt=0;
      for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
        const nx=x+dx, ny=y+dy;
        if (nx>=0&&nx<W&&ny>=0&&ny<H) { sum+=sm[idx(nx,ny)]; cnt++; }
      }
      sm[idx(x,y)] = sum/cnt;
    }
  }
  const inBound = [];
  for (let y=0; y<H; y++) for (let x=0; x<W; x++)
    if (isInHexBounds(x,y,W,H)) inBound.push(sm[idx(x,y)]);
  const threshold = inBound.slice().sort((a,b)=>a-b)[Math.floor(inBound.length*0.52)];

  const tiles = [];
  for (let y=0; y<H; y++) {
    tiles.push([]);
    for (let x=0; x<W; x++) {
      if (!isInHexBounds(x,y,W,H)) { tiles[y].push({type:'void',owner:null,city:null}); continue; }
      tiles[y].push({ type: sm[idx(x,y)] >= threshold ? 'land' : 'ocean', owner:null, city:null });
    }
  }

  function isCoastal(x,y) {
    return hexNeighbors(x,y,W,H).some(n => tiles[n.y][n.x].type === 'ocean');
  }

  // Find landmasses
  const visited = new Set();
  const landmasses = [];
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const t = tiles[y][x];
    if (t.type !== 'ocean' && t.type !== 'void' && !visited.has(y*W+x)) {
      const mass = [];
      const q = [[x,y]];
      while (q.length) {
        const [cx,cy] = q.shift();
        const k = cy*W+cx;
        if (visited.has(k)) continue;
        visited.add(k); mass.push([cx,cy]);
        for (const nb of hexNeighbors(cx,cy,W,H)) {
          const nt = tiles[nb.y][nb.x];
          if (!visited.has(nb.y*W+nb.x) && nt.type !== 'ocean' && nt.type !== 'void')
            q.push([nb.x,nb.y]);
        }
      }
      landmasses.push(mass);
    }
  }

  const cities = [];
  const minDist = 4;

  function placeCity(cx,cy) {
    cities.push([cx,cy]);
    tiles[cy][cx].type = 'city';
    tiles[cy][cx].city = { owner:null, production:null, progress:0, id:cities.length-1, coastal:isCoastal(cx,cy) };
  }

  function tryPlace(candidates) {
    shuffle(candidates);
    for (const [cx,cy] of candidates) {
      if (cities.every(([ex,ey]) => hexDistance(cx,cy,ex,ey) >= minDist)) { placeCity(cx,cy); return true; }
    }
    return false;
  }

  for (const mass of landmasses) {
    if (mass.length < 2) continue;
    const coastal = mass.filter(([x,y]) => isCoastal(x,y));
    tryPlace(coastal);
    const slots = Math.max(0, Math.floor(mass.length/8));
    for (let i=0; i<slots; i++) tryPlace([...coastal, ...mass.filter(([x,y]) => !isCoastal(x,y))]);
  }

  // Extra cities for isolated land
  const allLand = [];
  for (let y=0; y<H; y++) for (let x=0; x<W; x++)
    if (tiles[y][x].type === 'land') allLand.push([x,y]);
  shuffle(allLand);
  for (const [lx,ly] of allLand) {
    const near = cities.some(([cx,cy]) => hexDistance(lx,ly,cx,cy) <= 10);
    if (!near && cities.every(([ex,ey]) => hexDistance(lx,ly,ex,ey) >= minDist)) placeCity(lx,ly);
  }

  // Assign start cities
  let p1City = cities.find(([x,y]) => x < W/2 && y < H/2) || cities[0];
  let p2City = cities.find(([x,y]) => x >= W/2 && y >= H/2) || cities[cities.length-1];

  return { tiles, cities, p1City, p2City };
}

// ── State helpers ─────────────────────────────────────────────────────────
let uidCtr = 0;
function newUid() { return ++uidCtr; }

function getTileUnitCount(state, x, y) {
  return state.units.filter(u => u.x===x && u.y===y).length;
}

function spawnUnit(state, owner, type, x, y) {
  if (getTileUnitCount(state, x, y) >= 2) return null;
  const def = UNIT_DEFS[type];
  const unit = { id: newUid(), owner, type, x, y, movesLeft: def.move, fuel: def.fuel,
                  hp: def.maxHp, maxHp: def.maxHp, cargo: [], hasAttacked: false };
  state.units.push(unit);
  return unit;
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

function getVisibleTiles(state, playerNum) {
  const {mapW:W, mapH:H} = state;
  const visible = new Set();
  function reveal(cx,cy) {
    const q = [[cx,cy,0]]; const seen = new Set([cy*W+cx]);
    visible.add(cy*W+cx);
    while (q.length) {
      const [qx,qy,dist] = q.shift();
      if (dist >= 2) continue;
      for (const nb of hexNeighbors(qx,qy,W,H)) {
        if (state.tiles[nb.y][nb.x].type === 'void') continue;
        const k = nb.y*W+nb.x;
        if (!seen.has(k)) { seen.add(k); visible.add(k); q.push([nb.x,nb.y,dist+1]); }
      }
    }
  }
  for (const u of state.units) if (u.owner === playerNum) reveal(u.x, u.y);
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const t = state.tiles[y][x];
    if (t.type==='city' && t.city && t.city.owner===playerNum) reveal(x,y);
  }
  if (state.exploredTiles && state.exploredTiles[playerNum])
    for (const k of visible) state.exploredTiles[playerNum].add(k);
  return visible;
}

function countCities(state, player) {
  let c = 0;
  for (const row of state.tiles) for (const t of row)
    if (t.type==='city' && t.city && t.city.owner===player) c++;
  return c;
}

function checkWin(state) {
  const p1c = countCities(state,1), p2c = countCities(state,2);
  const p1u = state.units.filter(u=>u.owner===1).length;
  const p2u = state.units.filter(u=>u.owner===2).length;
  if (p2c===0 && p2u===0) { state.winner=1; state.phase='ended'; }
  else if (p1c===0 && p1u===0) { state.winner=2; state.phase='ended'; }
}

// ── Combat ────────────────────────────────────────────────────────────────
function resolveCombat(state, attacker, defender, stats) {
  const atkS = UNIT_COMBAT[attacker.type] || {attack:1,defense:1};
  const defS = UNIT_COMBAT[defender.type] || {attack:1,defense:1};
  if (!attacker.hp) { attacker.hp = UNIT_DEFS[attacker.type]?.maxHp||3; attacker.maxHp = attacker.hp; }
  if (!defender.hp) { defender.hp = UNIT_DEFS[defender.type]?.maxHp||3; defender.maxHp = defender.hp; }

  let rolls = 0, atkDmg = 0, defDmg = 0;
  do {
    const ar = Math.ceil(Math.random()*6), dr = Math.ceil(Math.random()*6);
    atkDmg = ar <= atkS.attack ? ar : 0;
    defDmg = dr <= defS.defense ? dr : 0;
    rolls++;
  } while (atkDmg===0 && defDmg===0 && rolls < 20);

  if (atkDmg > 0) defender.hp = Math.max(0, defender.hp - atkDmg);
  if (defDmg > 0) attacker.hp = Math.max(0, attacker.hp - defDmg);

  if (stats) {
    stats.attacks++;
    stats.attacksByPlayer[attacker.owner] = (stats.attacksByPlayer[attacker.owner]||0)+1;
    if (defender.hp <= 0) stats.unitsLost[defender.owner] = (stats.unitsLost[defender.owner]||0)+1;
    if (attacker.hp <= 0) stats.unitsLost[attacker.owner] = (stats.unitsLost[attacker.owner]||0)+1;
  }

  if (attacker.hp <= 0 && defender.hp <= 0) {
    state.units = state.units.filter(u => u.id!==attacker.id && u.id!==defender.id);
    return null;
  } else if (defender.hp <= 0) {
    state.units = state.units.filter(u => u.id!==defender.id);
    return attacker;
  } else if (attacker.hp <= 0) {
    state.units = state.units.filter(u => u.id!==attacker.id);
    return null;
  }
  return attacker;
}

function doMove(state, unit, toX, toY, stats) {
  const {mapW:W, mapH:H} = state;
  if (toX<0||toX>=W||toY<0||toY>=H) return;
  const destTile = state.tiles[toY][toX];
  const def = UNIT_DEFS[unit.type];
  if (!destTile || destTile.type==='void') return;
  if (!checkMoveDomain(def.domain, destTile.type, destTile)) return;

  const enemies = state.units.filter(u => u.owner!==unit.owner && u.x===toX && u.y===toY);
  if (enemies.length===0 && getTileUnitCount(state,toX,toY)>=2) return;

  for (const enemy of enemies) {
    const survivor = resolveCombat(state, unit, enemy, stats);
    if (!survivor || survivor.id!==unit.id) return;
    if (!state.units.find(u=>u.id===unit.id)) return;
  }

  // Don't let air units capture cities
  if (def.domain==='air' && destTile.type==='city' && destTile.city && destTile.city.owner!==unit.owner && destTile.city.owner!==0) {
    unit.movesLeft = Math.max(0, unit.movesLeft-1);
    return;
  }

  unit.x = toX; unit.y = toY;
  unit.movesLeft = Math.max(0, unit.movesLeft-1);

  if (destTile.type==='city' && destTile.city && destTile.city.owner!==unit.owner && def.canCapture) {
    if (stats) { stats.citiesCaptured++; stats.citiesCapturedBy[unit.owner] = (stats.citiesCapturedBy[unit.owner]||0)+1; }
    destTile.city.owner = unit.owner;
    destTile.city.production = 'army';
    destTile.city.progress = 0;
    // Unit is consumed by capture (as in original)
    state.units = state.units.filter(u => u.id!==unit.id);
    return;
  }

  if (unit.fuel!==null) {
    const t = state.tiles[toY][toX];
    const onBase = (t.type==='city' && t.city && t.city.owner===unit.owner) ||
                   state.units.some(u=>u!==unit && u.owner===unit.owner && u.type==='carrier' && u.x===toX && u.y===toY);
    if (onBase) unit.fuel = UNIT_DEFS[unit.type].fuel;
  }
}

function aiBFS(state, sx, sy, gx, gy, domain) {
  const {mapW:W, mapH:H} = state;
  if (sx===gx && sy===gy) return null;
  const visited = new Set([sy*W+sx]);
  const q = [{x:sx, y:sy, path:[]}];
  while (q.length) {
    const {x,y,path} = q.shift();
    for (const nb of hexNeighbors(x,y,W,H)) {
      const k = nb.y*W+nb.x;
      if (visited.has(k)) continue;
      visited.add(k);
      const tile = state.tiles[nb.y][nb.x];
      if (!tile || tile.type==='void') continue;
      if (!checkMoveDomain(domain, tile.type, tile)) continue;
      if (getTileUnitCount(state,nb.x,nb.y)>=2) {
        const hasEnemy = state.units.some(u=>u.x===nb.x && u.y===nb.y);
        if (!hasEnemy) continue;
      }
      const np = [...path, {x:nb.x,y:nb.y}];
      if (nb.x===gx && nb.y===gy) return np[0]||null;
      q.push({x:nb.x, y:nb.y, path:np});
    }
  }
  return null;
}

function onSameLandmass(state, x1,y1,x2,y2) {
  const {mapW:W,mapH:H} = state;
  const visited = new Set([y1*W+x1]);
  const q = [[x1,y1]];
  while (q.length) {
    const [cx,cy] = q.shift();
    if (cx===x2&&cy===y2) return true;
    for (const nb of hexNeighbors(cx,cy,W,H)) {
      const k = nb.y*W+nb.x;
      if (visited.has(k)) continue;
      const t = state.tiles[nb.y][nb.x];
      if (t && (t.type==='land'||t.type==='city')) { visited.add(k); q.push([nb.x,nb.y]); }
    }
  }
  return false;
}

// ── AI v2 (runAILevel3 from server.js, adapted for symmetric play) ────────
function runAIV2(state, playerNum, stats) {
  const {mapW:W, mapH:H} = state;
  const opponent = playerNum===1 ? 2 : 1;

  // Full visibility for sim
  const aiVisible = getVisibleTiles(state, playerNum);
  const aiExplored = state.exploredTiles ? state.exploredTiles[playerNum] : null;
  function canSee(x,y) { return aiVisible.has(y*W+x); }

  const aiUnits = state.units.filter(u=>u.owner===playerNum);
  const p1Units = state.units.filter(u=>u.owner===opponent && canSee(u.x,u.y));

  const neutralCities=[], friendlyCities=[], enemyCities=[];
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const tile = state.tiles[y][x];
    if (tile.type!=='city'||!tile.city) continue;
    const k = y*W+x;
    const known = aiVisible.has(k)||(aiExplored&&aiExplored.has(k));
    if (!known) continue;
    const pos = {x,y,city:tile.city,tile};
    if (!tile.city.owner||tile.city.owner===0) neutralCities.push(pos);
    else if (tile.city.owner===playerNum) friendlyCities.push(pos);
    else enemyCities.push(pos);
  }

  const aiCounts = {};
  for (const u of aiUnits) aiCounts[u.type] = (aiCounts[u.type]||0)+1;
  const allKnownCities = neutralCities.length + friendlyCities.length + enemyCities.length;
  const aiCityAdvantage = friendlyCities.length > (allKnownCities/2);

  const landAI = aiUnits.filter(u=>UNIT_DEFS[u.type]?.domain==='land');
  const enemyReachableByLand = enemyCities.length>0 && landAI.some(u=>
    enemyCities.some(ec=>onSameLandmass(state,u.x,u.y,ec.x,ec.y))
  );
  const needNaval = enemyCities.length>0 && !enemyReachableByLand && landAI.length>0;

  // Production
  for (const cp of friendlyCities) {
    const tile = cp.tile;
    if (tile.city.production) continue;
    const isCoastal = tile.city.coastal;
    const enemyHasAir = p1Units.some(u=>u.type==='fighter'||u.type==='bomber');
    const needFighters = enemyHasAir && (aiCounts['fighter']||0)<2;
    const hasTransport = (aiCounts['transport']||0)>0;
    let prod;
    if (needNaval && isCoastal && !hasTransport) prod='transport';
    else if (needFighters && isCoastal) prod='fighter';
    else if ((aiCounts['tank']||0)<2) prod='tank';
    else if (isCoastal && needNaval && (aiCounts['destroyer']||0)<1) prod='destroyer';
    else prod = Math.random()<0.5 ? 'tank' : 'army';
    tile.city.production = prod;
    tile.city.progress = 0;
  }

  function hpRatio(u) { return u.maxHp ? u.hp/u.maxHp : 1; }

  function nearestSafeBase(unit) {
    let best=null, bestD=Infinity;
    for (const fc of friendlyCities) {
      const d = hexDistance(unit.x,unit.y,fc.x,fc.y);
      if (d<bestD) { bestD=d; best=fc; }
    }
    return best;
  }

  function attackScore(atk, def) {
    let s = 0;
    const defHp = hpRatio(def);
    s += (1-defHp)*80;
    if (defHp<0.25) s+=100;
    const val = {battleship:40,carrier:40,bomber:35,fighter:30,tank:25,destroyer:20,army:15,transport:15,submarine:15};
    s += val[def.type]||10;
    if (hpRatio(atk)<0.35) s-=20;
    return s;
  }

  function bestCityTarget(unit, domain) {
    let best=null, bestSc=-Infinity;
    for (const ec of enemyCities) {
      if (domain!=='land'&&domain!=='air') continue;
      const d = hexDistance(unit.x,unit.y,ec.x,ec.y);
      const sc = 200-d*2;
      if (sc>bestSc) { bestSc=sc; best=ec; }
    }
    for (const nc of neutralCities) {
      if (domain!=='land') continue;
      const d = hexDistance(unit.x,unit.y,nc.x,nc.y);
      const sc = 100-d;
      if (sc>bestSc) { bestSc=sc; best=nc; }
    }
    return best;
  }

  // First contact detection
  if (!state.firstContactTurn) {
    for (const u of aiUnits) {
      if (p1Units.some(e=>hexDistance(u.x,u.y,e.x,e.y)<=2)) {
        state.firstContactTurn = state.turn;
      }
    }
  }

  const movedIds = new Set();
  const unitQueue = [...aiUnits].sort((a,b) => {
    const aAdj = state.units.some(u=>u.owner===opponent&&hexDistance(a.x,a.y,u.x,u.y)===1);
    const bAdj = state.units.some(u=>u.owner===opponent&&hexDistance(b.x,b.y,u.x,u.y)===1);
    if (aAdj!==bAdj) return aAdj?-1:1;
    const ac=UNIT_DEFS[a.type]?.canCapture, bc=UNIT_DEFS[b.type]?.canCapture;
    if (ac!==bc) return ac?-1:1;
    return 0;
  });

  for (const unit of unitQueue) {
    if (unit.movesLeft<=0||movedIds.has(unit.id)) continue;
    const def = UNIT_DEFS[unit.type];
    if (!def) continue;
    const domain = def.domain;

    // Low fuel: return to base
    if (unit.fuel!==null && unit.fuel<=Math.ceil(def.move*0.35)) {
      const base = nearestSafeBase(unit);
      if (base) {
        const step = aiBFS(state,unit.x,unit.y,base.x,base.y,domain);
        if (step) { doMove(state,unit,step.x,step.y,stats); movedIds.add(unit.id); continue; }
      }
    }

    // Retreat if badly damaged
    if (hpRatio(unit)<0.3 && domain!=='air') {
      const base = nearestSafeBase(unit);
      if (base && hexDistance(unit.x,unit.y,base.x,base.y)>1) {
        const step = aiBFS(state,unit.x,unit.y,base.x,base.y,domain);
        if (step) { doMove(state,unit,step.x,step.y,stats); movedIds.add(unit.id); continue; }
      }
    }

    let bestAction=null, bestSc=-Infinity;

    // A: Attack adjacent
    if (!unit.hasAttacked) {
      const adjEnemies = p1Units.filter(e=>hexDistance(unit.x,unit.y,e.x,e.y)===1);
      for (const enemy of adjEnemies) {
        const sc = attackScore(unit,enemy)+150;
        if (sc>bestSc) { bestSc=sc; bestAction={type:'attack',enemy}; }
      }
    }

    // B: Move into enemy tile
    if (unit.movesLeft>0) {
      for (const nb of hexNeighbors(unit.x,unit.y,W,H)) {
        const tile = state.tiles[nb.y][nb.x];
        if (!tile||!checkMoveDomain(domain,tile.type,tile)) continue;
        const enemies = state.units.filter(u=>u.owner===opponent&&u.x===nb.x&&u.y===nb.y);
        if (enemies.length>0) {
          const sc = attackScore(unit,enemies[0])+120;
          if (sc>bestSc) { bestSc=sc; bestAction={type:'move',step:{x:nb.x,y:nb.y}}; }
        }
      }
    }

    // C: Capture city
    if (def.canCapture && unit.movesLeft>0) {
      const ct = bestCityTarget(unit,domain);
      if (ct) {
        const step = aiBFS(state,unit.x,unit.y,ct.x,ct.y,domain);
        if (step) {
          const d = hexDistance(unit.x,unit.y,ct.x,ct.y);
          const isEnemy = ct.city.owner===opponent;
          const sc = (isEnemy?180:90)-d;
          if (sc>bestSc) { bestSc=sc; bestAction={type:'move',step}; }
        }
      }
    }

    // D: Advance toward lowest-HP known enemy
    if (unit.movesLeft>0 && p1Units.length>0) {
      let bestT=null, bestTSc=-Infinity;
      for (const eu of p1Units) {
        const euDef = UNIT_DEFS[eu.type];
        if (!euDef) continue;
        if (domain==='land'&&euDef.domain==='sea') continue;
        if (domain==='sea'&&euDef.domain==='land') continue;
        const d = hexDistance(unit.x,unit.y,eu.x,eu.y);
        const tsc = (1-hpRatio(eu))*60 + 30 - d*0.5;
        if (tsc>bestTSc) { bestTSc=tsc; bestT=eu; }
      }
      if (bestT) {
        const step = aiBFS(state,unit.x,unit.y,bestT.x,bestT.y,domain);
        if (step) {
          const sc = 40+bestTSc*0.5;
          if (sc>bestSc) { bestSc=sc; bestAction={type:'move',step}; }
        }
      }
    }

    // E: Advance toward enemy city if city advantage
    if (unit.movesLeft>0 && aiCityAdvantage && enemyCities.length>0) {
      let best=null, bestD=Infinity;
      for (const ec of enemyCities) {
        const d=hexDistance(unit.x,unit.y,ec.x,ec.y);
        if (d<bestD) { bestD=d; best=ec; }
      }
      if (best) {
        const step = aiBFS(state,unit.x,unit.y,best.x,best.y,domain);
        if (step) {
          const sc=35-bestD*0.3;
          if (sc>bestSc) { bestSc=sc; bestAction={type:'move',step}; }
        }
      }
    }

    // F: Explore
    if (!bestAction && unit.movesLeft>0) {
      let bestEx=null, bestExD=Infinity;
      for (let dy=-12; dy<=12; dy++) for (let dx=-12; dx<=12; dx++) {
        const ex=unit.x+dx, ey=unit.y+dy;
        if (ex<0||ex>=W||ey<0||ey>=H) continue;
        const ek=ey*W+ex;
        if (aiVisible.has(ek)||(aiExplored&&aiExplored.has(ek))) continue;
        const tile=state.tiles[ey][ex];
        if (!tile||tile.type==='void'||!checkMoveDomain(domain,tile.type,tile)) continue;
        const d=hexDistance(unit.x,unit.y,ex,ey);
        if (d<bestExD) { bestExD=d; bestEx={x:ex,y:ey}; }
      }
      if (bestEx) {
        const step = aiBFS(state,unit.x,unit.y,bestEx.x,bestEx.y,domain);
        if (step) { bestSc=5; bestAction={type:'move',step}; }
      }
    }

    // Execute
    if (bestAction) {
      if (bestAction.type==='attack') {
        const enemy = state.units.find(u=>u.id===bestAction.enemy.id);
        if (enemy) {
          resolveCombat(state,unit,enemy,stats);
          unit.hasAttacked=true;
          if (unit.fuel!==null) unit.fuel=Math.max(0,unit.fuel-1);
        }
      } else {
        doMove(state,unit,bestAction.step.x,bestAction.step.y,stats);
        const stillAlive = state.units.find(u=>u.id===unit.id);
        if (stillAlive && !stillAlive.hasAttacked) {
          const adjAfter = state.units.filter(u=>u.owner===opponent&&hexDistance(stillAlive.x,stillAlive.y,u.x,u.y)===1);
          if (adjAfter.length>0) {
            const target = adjAfter.sort((a,b)=>(a.hp||99)-(b.hp||99))[0];
            const still = state.units.find(u=>u.id===target.id);
            if (still) { resolveCombat(state,stillAlive,still,stats); stillAlive.hasAttacked=true; }
          }
        }
      }
      movedIds.add(unit.id);
    }
  }
}

// ── Production tick ───────────────────────────────────────────────────────
function doProductionTick(state, playerNum) {
  const {mapW:W, mapH:H} = state;
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const tile = state.tiles[y][x];
    if (tile.type!=='city'||!tile.city) continue;
    const city = tile.city;
    if (city.owner!==playerNum||!city.production) continue;
    city.progress++;
    const bt = UNIT_DEFS[city.production]?.buildTime||99;
    if (city.progress>=bt) {
      spawnUnit(state, city.owner, city.production, x, y);
      city.progress=0;
    }
  }
}

function doFuelBurn(state, playerNum) {
  for (const u of [...state.units]) {
    if (u.fuel===null||u.owner!==playerNum) continue;
    const tile = state.tiles[u.y][u.x];
    const onBase = (tile.type==='city'&&tile.city&&tile.city.owner===playerNum)||
                   state.units.some(c=>c!==u&&c.owner===playerNum&&c.type==='carrier'&&c.x===u.x&&c.y===u.y);
    if (onBase) continue;
    u.fuel=Math.max(0,u.fuel-1);
    if (u.fuel<=0) state.units=state.units.filter(x=>x.id!==u.id);
  }
}

function restoreMovement(state, playerNum) {
  for (const u of state.units) {
    if (u.owner!==playerNum) continue;
    u.movesLeft = UNIT_DEFS[u.type]?.move||1;
    u.hasAttacked = false;
    if (u.hp!=null&&u.maxHp!=null&&u.hp<u.maxHp) {
      u.hp = Math.min(u.maxHp, u.hp+Math.ceil(u.maxHp/3));
    }
  }
}

// ── Run one game ──────────────────────────────────────────────────────────
function runGame(gameNum) {
  const mapData = generateMap(MAP_W, MAP_H);
  const { tiles, p1City, p2City } = mapData;

  tiles[p1City[1]][p1City[0]].city.owner = 1;
  tiles[p1City[1]][p1City[0]].city.production = 'army';
  tiles[p2City[1]][p2City[0]].city.owner = 2;
  tiles[p2City[1]][p2City[0]].city.production = 'army';

  const state = {
    phase: 'playing', units: [], turn: 1, activePlayer: 1,
    winner: null, firstContactTurn: null,
    tiles, mapW: MAP_W, mapH: MAP_H,
    exploredTiles: [null, new Set(), new Set()],
  };

  spawnUnit(state, 1, 'army', p1City[0], p1City[1]);
  spawnUnit(state, 2, 'army', p2City[0], p2City[1]);

  const stats = {
    attacks: 0,
    attacksByPlayer: {1:0, 2:0},
    citiesCaptured: 0,
    citiesCapturedBy: {1:0, 2:0},
    unitsLost: {1:0, 2:0},
    attacksByTurn: {},
  };

  let halfTurnCount = 0;

  while (state.phase !== 'ended' && halfTurnCount < MAX_TURNS*2) {
    const cur = state.activePlayer;
    const opp = cur===1?2:1;
    const prevAtk = stats.attacks;

    runAIV2(state, cur, stats);

    const attacksThisHalf = stats.attacks - prevAtk;
    stats.attacksByTurn[state.turn] = (stats.attacksByTurn[state.turn]||0) + attacksThisHalf;

    doFuelBurn(state, opp);
    doProductionTick(state, opp);
    restoreMovement(state, opp);
    checkWin(state);
    if (state.phase==='ended') break;

    if (cur===1) state.activePlayer=2;
    else { state.activePlayer=1; state.turn++; }
    halfTurnCount++;
  }

  return {
    winner: state.winner,
    turns: state.turn,
    stats,
    firstContact: state.firstContactTurn,
    finalP1Cities: countCities(state,1),
    finalP2Cities: countCities(state,2),
    finalP1Units: state.units.filter(u=>u.owner===1).length,
    finalP2Units: state.units.filter(u=>u.owner===2).length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
console.log(`\n🎮 Stratcon AI v2 Simulation — ${NUM_GAMES} games (20×20)\n`);
console.log('─'.repeat(65));

const results = [];
for (let g=0; g<NUM_GAMES; g++) {
  process.stdout.write(`  Game ${g+1}/${NUM_GAMES}... `);
  const r = runGame(g+1);
  results.push(r);
  const fc = r.firstContact || 'never';
  const wStr = r.winner ? `P${r.winner} wins` : 'TIMEOUT';
  console.log(`${wStr} | Turn ${r.turns} | First contact: T${fc} | Atk: ${r.stats.attacks} | Cities P1:${r.finalP1Cities} P2:${r.finalP2Cities}`);
}

// ── Aggregate ──────────────────────────────────────────────────────────────
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

const p1Wins = results.filter(r=>r.winner===1).length;
const p2Wins = results.filter(r=>r.winner===2).length;
const timeouts = results.filter(r=>!r.winner).length;
const decisive = NUM_GAMES - timeouts;

const avgTurns = avg(results.map(r=>r.turns));
const firstContacts = results.map(r=>r.firstContact).filter(x=>x&&x!=='never').map(Number);
const avgFC = avg(firstContacts);
const avgAtk = avg(results.map(r=>r.stats.attacks/Math.max(1,r.turns)));
const avgCitiesP1 = avg(results.map(r=>r.stats.citiesCapturedBy[1]||0));
const avgCitiesP2 = avg(results.map(r=>r.stats.citiesCapturedBy[2]||0));
const avgUnitsLostP1 = avg(results.map(r=>r.stats.unitsLost[1]||0));
const avgUnitsLostP2 = avg(results.map(r=>r.stats.unitsLost[2]||0));

console.log('\n' + '═'.repeat(65));
console.log('📊 AI V2 RESULTS');
console.log('═'.repeat(65));
console.log(`Wins: P1=${p1Wins}  P2=${p2Wins}  Timeout=${timeouts}/${NUM_GAMES}`);
console.log(`Decisive games: ${decisive}/${NUM_GAMES} (${(decisive/NUM_GAMES*100).toFixed(0)}%)`);
console.log(`Avg turns: ${avgTurns.toFixed(1)}  (prev: 151)`);
console.log(`Avg first contact: T${avgFC.toFixed(1)}`);
console.log(`Avg attacks/turn: ${avgAtk.toFixed(2)}`);
console.log(`Avg cities captured — P1: ${avgCitiesP1.toFixed(1)}  P2: ${avgCitiesP2.toFixed(1)}`);
console.log(`Avg units lost — P1: ${avgUnitsLostP1.toFixed(1)}  P2: ${avgUnitsLostP2.toFixed(1)}`);
console.log('═'.repeat(65));

// Export for Discord
const fs = require('fs');
fs.writeFileSync('/home/node/.openclaw/workspace/stratcon/ai-sim-v2-results.json', JSON.stringify({
  p1Wins, p2Wins, timeouts, decisive, numGames: NUM_GAMES,
  avgTurns: parseFloat(avgTurns.toFixed(1)),
  avgFirstContact: parseFloat(avgFC.toFixed(1)),
  avgAttacksPerTurn: parseFloat(avgAtk.toFixed(2)),
  avgCitiesP1: parseFloat(avgCitiesP1.toFixed(1)),
  avgCitiesP2: parseFloat(avgCitiesP2.toFixed(1)),
  avgUnitsLostP1: parseFloat(avgUnitsLostP1.toFixed(1)),
  avgUnitsLostP2: parseFloat(avgUnitsLostP2.toFixed(1)),
  results: results.map((r,i) => ({
    game: i+1,
    winner: r.winner,
    turns: r.turns,
    firstContact: r.firstContact,
    attacks: r.stats.attacks,
    citiesP1: r.finalP1Cities,
    citiesP2: r.finalP2Cities,
  }))
}, null, 2));
console.log('✅ Results saved to ai-sim-v2-results.json\n');
