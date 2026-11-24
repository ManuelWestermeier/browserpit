// Local manager app: http://127.0.0.1:<port>, opened as its own app window.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import * as core from './core.js';

const UI = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

export async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(600) });
    return r.ok && (await r.json()).app === 'browserpit';
  } catch { return false; }
}

export function serve(port, version) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // only this machine, only this origin (no DNS rebinding, no cross-site requests)
    if (!hosts.has(req.headers.host ?? '')) return send(403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && (!origin || !hosts.has(origin.replace(/^http:\/\//, '')) || !/json/.test(req.headers['content-type'] ?? ''))) return send(403, { error: 'forbidden origin' });
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, UI.replace('%VERSION%', version), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(200, { app: 'browserpit', version });
      if (req.method === 'GET' && url.pathname === '/api/instances') return send(200, { home: core.HOME, instances: await core.list() });
      if (req.method === 'POST') {
        const body = await new Promise((resolve, reject) => {
          let s = '';
          req.on('data', (c) => { s += c; if (s.length > 10_000) reject(new core.UserError('too large')); });
          req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new core.UserError('bad json')); } });
        });
        const m = url.pathname.match(/^\/api\/instances(?:\/([a-z0-9-]+)(?:\/(start|stop|update|delete|folder))?)?$/);
        if (!m) return send(404, { error: 'not found' });
        const [, id, op] = m;
        if (!id) return send(200, core.create(body));
        if (op === 'start') return send(200, { port: await core.start(id, { url: body.url }) });
        if (op === 'stop') { await core.stop(id); return send(200, {}); }
        if (op === 'update') return send(200, core.update(id, body));
        if (op === 'delete') { await core.remove(id); return send(200, {}); }
        if (op === 'folder') { openPath(core.dataDir(id)); return send(200, {}); }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      send(e instanceof core.UserError ? 400 : 500, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function openPath(p) {
  fs.mkdirSync(p, { recursive: true });
  const [cmd, args] = process.platform === 'win32' ? ['explorer', [p]] : process.platform === 'darwin' ? ['open', [p]] : ['xdg-open', [p]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** The manager as a chromeless app window (own profile, so it never mixes with your instances). */
export function openApp(url) {
  const exe = core.findExecutable('auto');
  if (exe) {
    spawn(exe, [`--app=${url}`, `--user-data-dir=${path.join(core.HOME, 'app-window')}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=980,720'],
      { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
