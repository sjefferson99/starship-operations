# Starship Operations

A browser dashboard game: keep a worn-out salvage ship — and its crew — alive.

**_This game is in early proof of concept stage, there is no finished plot, plenty of bugs and approximiately 10 minutes of gameplay right now. But it shows the concept and how it could grow._**

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or newer (the game uses Node's built-in SQLite for save games)

There is nothing to install or build to play.

## Launching the game

From the project folder:

```
npm start
```

Then open <http://localhost:3001> in your browser.

Leave the terminal window open while you play — it's the server that stores your save games. Press `Ctrl+C` in it to shut the game down.

## Playing

Click **New Game**, name your save, and confirm the sector seed. A guided tour starts on your first game and walks you through the basics; you can replay it at any time with the **Tour** button at the top of the dashboard.

- **Esc** pauses the game and opens the save menu.
- The **Sounds** button at the top of the dashboard opens the volume controls (overall, buttons, effects, alerts and the systems hum), and can turn sound off.
- The game also autosaves every five minutes.
- **Load Game** on the main menu lists your saves.

Saves are stored in `savegame/game.db`.

## Running the tests (optional)

```
npm install
npx playwright install chromium
npm test
```

Stop any running copy of the game first, so the tests start their own server against a separate test database.
