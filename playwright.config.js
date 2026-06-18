const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: false, // tests share the savegame/server state
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:3001',
    },
    webServer: {
        command: 'node --no-warnings server.js',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        // Isolated, pristine DB — never the developer's real savegame/game.db.
        env: { GAME_DB_PATH: path.join(__dirname, 'test-results', 'test-game.db') },
    },
});
