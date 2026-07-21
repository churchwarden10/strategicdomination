# Strategic Domination — Visual Polish Pass

## Changes Made to `public/index.html`

### 1. Ocean Tiles — Depth & Life
- Replaced flat `#0d2b4b` fill with a **radial gradient** (deep `#122f55` center → `#0a2040` edges) for a sense of water depth.
- Added a **slow sine-wave pulse** (period ~4s) that produces a subtle shimmer/glow overlay on each ocean tile. Each tile is phase-shifted by its column/row position so the whole map breathes organically, not uniformly.
- Added **faint wave strokes** at zoom ≥ 14px: two short arc-curves per tile, seeded deterministically by position so they're stable between frames but unique per tile.
- Pulse is alpha-driven (radial shimmer gradient), very subtle (~6% opacity swing).

### 2. Land Tiles — Organic Feel
- Replaced flat `#2d5a27` fill with a **radial gradient** (lighter `#3a6e30` center → darker `#224020` edges) for a more organic, rounded look.
- Added **grass/terrain texture dots** at zoom ≥ 14px: 5 small short strokes per tile, each seeded deterministically by tile position (col/row + index). Very low opacity (9–19%), reads as subtle terrain variation.

### 3. City Tiles — Iconic & Owned
- Added a **radial glow halo** behind each city's factory icon, colored by owner: blue (P1), red (P2), or neutral grey. The halo is clipped to the hex shape.
- Added an **owner-colored hex tint** at low opacity (18% blue, 18% red, 12% grey) as a second pass behind the icon.
- Increased the factory icon opacity from 0.75 → 0.88 for better readability.
- The **production progress ring** now renders in **two passes**: a wider glow pass (0.22 alpha) plus a crisp inner pass, making it visually more satisfying and easier to read at small sizes.

### 4. Fog Tiles — Atmospheric
- Replaced flat `#111` fill with a **subtle dark radial gradient** (`#1e1e1e` center → `#080808` edges) to give fog a sense of depth rather than a solid wall.
- Added **4 stable star-like dots** per fog tile at zoom ≥ 10px, using a seeded deterministic PRNG (LCG based on col/row). Dots are positioned within the hex, sized 0.5–1.3px, and drawn at 18–40% opacity in a cool blue-white tint. They are stable between renders (no flickering).

### 5. Hex Borders — Subtle & Per-Type
- **Ocean borders**: `rgba(60,120,200,0.28)` — slight blue tint, reduced opacity.
- **Land/City borders**: `rgba(80,140,60,0.22)` — slight green tint, very low opacity.
- Reduced line width from 0.8 → 0.7 and removed full-opacity white borders; the grid is now a gentle visual guide, not a cage.

### 6. Canvas Vignette
- A **radial gradient vignette** is drawn over the entire canvas after tiles but before units. It's transparent at the center (55% radius) and fades to 52% black at the edges. Gives the map a cinematic, immersive feel without obscuring gameplay.

### 7. Animation Architecture
- Added `_animNeeded`, `_animRafId`, `_lastAnimTime`, `_ANIM_THROTTLE` state variables.
- `startAnimLoop()` / `stopAnimLoop()` control a single `requestAnimationFrame` loop that only runs when ocean or fog tiles are in the viewport. It is **throttled to ~30fps** (`_ANIM_THROTTLE = 33ms`) to be mobile-friendly.
- The loop auto-stops when no animated tiles are visible, preventing idle GPU load.
- The `render()` function detects whether animated tiles are visible and toggles the loop accordingly.

### 8. Seeded Pseudo-Random Utility
- Added `seededRand(seed)` and `seededRandN(col, row, idx)` — simple LCG-based deterministic PRNG so fog stars and grass dots are stable across frames and unique per tile.

---

## Files Changed
- `public/index.html` — all changes are in the JS rendering section (`drawHex`, `render`, global animation state). No game logic was modified.

## Not Changed
- `server.js` — untouched.
- All game logic, input handling, socket events, unit movement/combat — unchanged.
