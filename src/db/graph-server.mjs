// The `hedgehog graph` live server: a standalone, detached process (see
// bin/cli.mjs's startOrReuseGraphServer) that serves the graph viewer
// page and a fresh /graph.json on every request, so an open browser tab
// polling /graph.json (src/templates/graph.html) sees task status
// changes as `hedgehog verify` makes them, without anyone re-running a
// CLI command or reloading the page.
//
// Runs as its own process rather than inline in a CLI command because
// `hedgehog graph` (and `hedgehog plan --open`) needs to exit promptly
// while the graph a human opened stays live. One process serves
// whichever project invoked it; a second invocation against the same
// project reuses it (see startOrReuseGraphServer's pidfile check) rather
// than starting a second server on the same database.
//
// Started only when a command is explicitly asked to open the graph.
// `hedgehog plan` on its own starts nothing: its caller is usually an
// agent in a headless session with no browser to hand the URL to, and
// starting this process there only leaves it behind, listening on
// 127.0.0.1 with an open handle on the build graph.

import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph } from './graph.mjs';

// Args: <db-path> <template-path> <pidfile-path>. Plain positional argv
// rather than a flags parser — this process is only ever spawned by
// bin/cli.mjs, never invoked directly by a person, so there's no usage
// text or flag surface to design for.
const [, , dbPath, templatePath, pidfilePath] = process.argv;

if (!dbPath || !templatePath || !pidfilePath) {
  console.error('graph-server.mjs requires <db-path> <template-path> <pidfile-path>');
  process.exit(1);
}

const template = await readFile(templatePath, 'utf8');

// graph.html loads React/ReactFlow/dagre from here rather than a CDN, so
// `hedgehog graph` works with no internet connection — vendored files
// live alongside the template at src/templates/vendor/.
const VENDOR_DIR = join(dirname(templatePath), 'vendor');
const VENDOR_CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function loadGraphJson() {
  // Opened and closed per request rather than held open: DatabaseSync is
  // synchronous and local, so the cost is negligible, and it avoids ever
  // serving a stale read against a handle opened before the last
  // `hedgehog verify` committed its transaction.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA synchronous = NORMAL');
    return buildGraph(db);
  } finally {
    db.close();
  }
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/vendor/')) {
    // Reject traversal/query strings before touching the filesystem —
    // the vendor set is fixed and flat, so anything else is not a file
    // this route is meant to serve.
    const name = req.url.slice('/vendor/'.length);
    const dotIndex = name.lastIndexOf('.');
    const ext = dotIndex === -1 ? '' : name.slice(dotIndex);
    if (!name || name.includes('/') || name.includes('..') || !(ext in VENDOR_CONTENT_TYPES)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const body = await readFile(join(VENDOR_DIR, name));
      res.writeHead(200, {
        'content-type': VENDOR_CONTENT_TYPES[ext],
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  if (req.url === '/graph.json') {
    let body;
    try {
      body = JSON.stringify(loadGraphJson());
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(template);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Port 0: ask the OS for any free port, so multiple hedgehog projects on
// one machine never collide. The chosen port is written to the pidfile
// once bound, which is the only way a caller (or a later invocation
// checking whether to reuse this server) learns what it is.
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await writeFile(pidfilePath, JSON.stringify({ pid: process.pid, port }));
  // Signals bin/cli.mjs's spawn-and-wait handshake that the server is
  // ready to accept requests, not just that the process has started.
  console.log(`LISTENING ${port}`);
});

async function shutdown() {
  server.close();
  await rm(pidfilePath, { force: true });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
