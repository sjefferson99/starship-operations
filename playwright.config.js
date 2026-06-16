const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: false, // tests share the savegame/server state
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:3001',
    },
    webServer: {
        command: 'node server.js',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
    },
});
