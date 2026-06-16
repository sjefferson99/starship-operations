# Repository Summary

### 1. Repository Overview
- Purpose: Game state management and simulation system with frontend UI
- Architectural style: Monolith
- Runtime environment: Node.js (server), HTML/JS (client)

---

### 2. Core Components
- **Game Engine**
  - Name: Core Simulation Logic
  - Responsibility: Manage game state transitions and physics
  - Key files: `game_state.js`, `system_update.js`
- **Server Backend**
  - Name: Node.js API Server
  - Responsibility: Handle HTTP requests and data persistence
  - Key files: `server.js`
- **Frontend UI**
  - Name: Web Interface
  - Responsibility: Render game elements and user interaction
  - Key files: `index.html`, `styles.css`
- **Data Manager**
  - Name: Ship & Story Data
  - Responsibility: Load ship classes and narrative content
  - Key files: `data/ship_classes.json`, `data/story_messages.json`

---

### 3. File Index
- `server.js` — API / backend (Node.js HTTP server)
- `game_state.js` — Core logic / game state management
- `system_update.js` — Utilities / simulation physics engine
- `index.html` — Frontend / UI (main HTML entry point)
- `styles.css` — Infrastructure / config (global styling)
- `data/ship_classes.json` — Data / database (ship definitions)
- `data/story_messages.json` — Data / database (narrative content)
- `assets/css/*css` — Infrastructure / config (styling components)

---

### 4. Data Model / Schema
Main entities:
- Ships (defined in `ship_classes.json`)
- Stories (defined in `story_messages.json`)
- Game state (managed in `game_state.js`)

Key relationships:
- Ships are referenced in story messages
- Game state tracks active ship and narrative progression

---

### 5. API / Interface Surface
Endpoints:
- `/api/update` (POST) - Send game state updates
- `/api/load` (GET) - Retrieve initial game data

Input/output summary:
- Inputs: JSON payloads with ship IDs and narrative choices
- Outputs: Serialized game state and response messages

---

### 6. Control Flow
- User action → `index.html` renders UI
- UI triggers `main.js` to send HTTP POST to `/api/update`
- Server processes update in `server.js`, writes to `game_state.js`
- Game state changes trigger re-render of UI via `system,system_update.js`

---

### 7. Dependencies
External libraries:
- Node.js (runtime)
- JSON (data serialization)

Frameworks:
- None identified

Internal dependencies:
- `server.js` depends on `game_state.js` for state persistence
- `main.js` depends on `styles.css` for UI rendering

---

### 8. Important Notes
- Hidden coupling: Game logic and UI share global state via `game_state.js`
- Global state: Centralized game state object in `game_state.js`
- Unusual pattern: No explicit database - data is JSON files
- Potential risk: Monolithic architecture may hinder scalability