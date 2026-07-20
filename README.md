# Strategic Domination

A browser-based multiplayer hex strategy game inspired by Axis & Allies.

## Start

```bash
npm install
npm start
```

## Node Version

Requires Node.js >= 18.0.0

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port the server listens on |

## Game Modes

- **1v1 Multiplayer** — share the room code with a friend
- **Solo vs AI** — play against the Level 3 AI opponent

## Tech Stack

- Node.js + Express
- Socket.IO (real-time game state)
- HTML5 Canvas (hex map rendering)
