// Simple dev server — serves static files and handles save-game I/O.
// No npm required: uses only Node.js built-ins (including node:sqlite for the DB).
//
// Usage:  node --no-warnings server.js
// Then open:  http://localhost:3000

const http = require('http');
const fs   = require('fs');
const path = require('path');
const db   = require('./db.js');

const ROOT     = __dirname;
const SAVE_DIR = path.join(ROOT, 'savegame');
const PORT     = Number(process.env.PORT) || 3001;

// GAME_DB_PATH lets tests point at an isolated, throwaway database instead of
// the real save — see playwright.config.js.
const DB_FILE = process.env.GAME_DB_PATH || path.join(SAVE_DIR, 'game.db');

const database = db.initDb(DB_FILE);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

function serveStatic(res, filePath) {
    const ext         = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readJsonBody(req, onDone) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            onDone(null, JSON.parse(body));
        } catch {
            onDone(new Error('Invalid JSON'));
        }
    });
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Save slots API ──────────────────────────────────────────────────────
    if (url === '/api/saves') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(db.listSaves(database)));

        } else if (req.method === 'POST') {
            readJsonBody(req, (err, json) => {
                if (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }
                const name = typeof json?.name === 'string' ? json.name.trim() : '';
                if (!name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'A save name is required' }));
                    return;
                }
                const created = db.createSave(database, name);
                if (!created) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `A save named "${name}" already exists` }));
                    return;
                }
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(created));
            });
        } else {
            res.writeHead(405); res.end();
        }
        return;
    }

    // ── Rewind checkpoints (docs/rewind-readiness.md) ───────────────────────
    const checkpointsMatch = url.match(/^\/api\/saves\/(\d+)\/checkpoints$/);
    if (checkpointsMatch) {
        const saveId = Number(checkpointsMatch[1]);
        if (req.method === 'GET') {
            sendJson(res, 200, db.listCheckpoints(database, saveId));
        } else if (req.method === 'POST') {
            readJsonBody(req, (err, json) => {
                if (err) return sendJson(res, 400, { error: 'Invalid JSON' });
                if (!db.CHECKPOINT_KINDS.includes(json?.kind) || !json?.world) {
                    return sendJson(res, 400, { error: 'A known kind and a world snapshot are required' });
                }
                try {
                    const created = db.addCheckpoint(database, saveId, json.kind, json);
                    if (!created) return sendJson(res, 404, { error: 'No save found' });
                    sendJson(res, 201, created);
                } catch {
                    sendJson(res, 500, { error: 'Checkpoint failed' });
                }
            });
        } else {
            res.writeHead(405); res.end();
        }
        return;
    }

    const restoreMatch = url.match(/^\/api\/saves\/(\d+)\/checkpoints\/(\d+)\/restore$/);
    if (restoreMatch) {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const saveId = Number(restoreMatch[1]);
        const checkpointId = Number(restoreMatch[2]);
        readJsonBody(req, (err, json) => {
            if (err) return sendJson(res, 400, { error: 'Invalid JSON' });
            try {
                const payload = db.restoreCheckpoint(database, saveId, checkpointId, json?.current ?? null);
                if (!payload) return sendJson(res, 404, { error: 'No such checkpoint' });
                sendJson(res, 200, payload);
            } catch {
                sendJson(res, 500, { error: 'Going back failed' });
            }
        });
        return;
    }

    const saveMatch = url.match(/^\/api\/saves\/(\d+)$/);
    if (saveMatch) {
        const saveId = Number(saveMatch[1]);

        if (req.method === 'GET') {
            const save = db.getSave(database, saveId);
            if (!save) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No save found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(save));

        } else if (req.method === 'PUT') {
            readJsonBody(req, (err, json) => {
                if (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }
                try {
                    db.saveSave(database, saveId, json);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Save failed: ' + e.message }));
                }
            });

        } else if (req.method === 'DELETE') {
            db.deleteSave(database, saveId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

        } else {
            res.writeHead(405); res.end();
        }
        return;
    }

    // ── Static file serving ──────────────────────────────────────────────────
    const reqPath  = url === '/' ? '/index.html' : url;
    const filePath = path.normalize(path.join(ROOT, reqPath));

    // Prevent path traversal outside project root
    const rel = path.relative(ROOT, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    serveStatic(res, filePath);
});

server.listen(PORT, () => {
    console.log(`\n  Starship Operations`);
    console.log(`  → http://localhost:${PORT}\n`);
});
