// Simple dev server — serves static files and handles save-game I/O.
// No npm required: uses only Node.js built-ins.
//
// Usage:  node server.js
// Then open:  http://localhost:3000

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT      = __dirname;
const SAVE_DIR  = path.join(ROOT, 'savegame');
const SAVE_FILE = path.join(SAVE_DIR, 'save.json');
const PORT      = 3001;

// Create savegame directory if it doesn't exist
fs.mkdirSync(SAVE_DIR, { recursive: true });

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
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

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Save-game API ────────────────────────────────────────────────────────
    if (url === '/api/save') {
        if (req.method === 'HEAD') {
            res.writeHead(fs.existsSync(SAVE_FILE) ? 200 : 404);
            res.end();

        } else if (req.method === 'GET') {
            if (!fs.existsSync(SAVE_FILE)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No save found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(fs.readFileSync(SAVE_FILE, 'utf8'));

        } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    JSON.parse(body); // validate before writing
                    fs.writeFileSync(SAVE_FILE, body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
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
