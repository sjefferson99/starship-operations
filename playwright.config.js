const { defineConfig } = require('@playwright/test');
const path = require('path');

// TEST_PORT runs the suite on its own server even while a manual `npm start`
// is using 3001. Without it, the existing server on 3001 is reused (see CLAUDE.md).
const port = Number(process.env.TEST_PORT) || 3001;

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: false, // tests share the savegame/server state
    reporter: 'list',
    use: {
        baseURL: `http://localhost:${port}`,
    },
    webServer: {
        command: 'node --no-warnings server.js',
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        // Isolated, pristine DB — never the developer's real savegame/game.db.
        env: { PORT: String(port), GAME_DB_PATH: path.join(__dirname, 'test-results', 'test-game.db') },
    },
});
