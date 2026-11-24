// Instances: one visible Chrome/Edge/Chromium window per ID, each with its own user-data-dir
// (cookies, logins, storage, cache, extensions never shared) and its own fixed DevTools port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const HOME = path.resolve(process.env.BROWSERPIT_HOME || path.join(os.homedir(), '.browserpit'));
const FILE = path.join(HOME, 'instances.json');
const BASE_PORT = 9400;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const ENGINES = ['auto', 'chrome', 'msedge', 'chromium'];
const COLORS = ['#e8a33d', '#5fa8d3', '#7cc48a', '#d9738f', '#a58bd6', '#d6c25c', '#5cc6b8', '#e07a5f'];

export class UserError extends Error {}

// ------------------------------------------------------------------ store

export function load() {
  try { const l = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(l) ? l.filter((i) => ID_RE.test(i?.id)) : []; } catch { return []; }
}
function save(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}
export const dataDir = (id) => path.join(HOME, 'profiles', id);
export const get = (id) => load().find((i) => i.id === id) ?? null;

export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function create({ id, name, engine = 'auto', color } = {}) {
  const list = load();
  id = slug(id || name || '');
  if (!ID_RE.test(id)) throw new UserError('Invalid ID – use a-z, 0-9 and "-".');
  if (list.some((i) => i.id === id)) throw new UserError(`"${id}" already exists.`);
  if (!ENGINES.includes(engine)) throw new UserError(`Engine must be one of ${ENGINES.join(', ')}.`);
  const used = new Set(list.map((i) => i.port));
  let port = BASE_PORT;
  while (used.has(port)) port++;
  const inst = { id, name: String(name || id).slice(0, 60), engine, color: /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : COLORS[list.length % COLORS.length], port, createdAt: Date.now() };
  save([...list, inst]);
  return inst;
}

export function update(id, patch) {
  const list = load();
  const inst = list.find((i) => i.id === id);
  if (!inst) throw new UserError(`No instance "${id}".`);
  if (typeof patch.name === 'string' && patch.name.trim()) inst.name = patch.name.trim().slice(0, 60);
  if (ENGINES.includes(patch.engine)) inst.engine = patch.engine;
  if (/^#[0-9a-f]{6}$/i.test(patch.color ?? '')) inst.color = patch.color;
  save(list);
  return inst;
}

export async function remove(id) {
  if (!get(id)) throw new UserError(`No instance "${id}".`);
  await stop(id);
  for (let i = 0; i < 30 && locked(dataDir(id)); i++) await sleep(200);
  fs.rmSync(dataDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  save(load().filter((i) => i.id !== id));
}

// ------------------------------------------------------------------ browsers

function first(paths) { return paths.find((p) => p && fs.existsSync(p)) ?? null; }

export function findExecutable(engine) {
  const env = process.env, win = process.platform === 'win32', mac = process.platform === 'darwin';
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const chrome = () => win ? first(pf.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')))
    : mac ? first(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
      : first(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']);
  const edge = () => win ? first(pf.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
    : mac ? first(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'])
      : first(['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge']);
  const chromium = () => {
    try {
      const pw = require(require.resolve('playwright-core', { paths: [path.dirname(require.resolve('@playwright/mcp/package.json'))] }));
      const exe = pw.chromium.executablePath();
      return exe && fs.existsSync(exe) ? exe : null;
    } catch { return first(['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']); }
  };
  if (engine === 'chrome') return chrome();
  if (engine === 'msedge') return edge();
  if (engine === 'chromium') return chromium();
  return chrome() || edge() || chromium();
}

/** Chromium holds the profile while it runs – a second process on the same dir would hand over and exit. */
export function locked(dir) {
  if (process.platform === 'win32') {
    const f = path.join(dir, 'lockfile');
    if (!fs.existsSync(f)) return false;
    try { fs.closeSync(fs.openSync(f, 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM'; }
  }
  try {
    const pid = Number(fs.readlinkSync(path.join(dir, 'SingletonLock')).split('-').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) { return e.code === 'EPERM'; }
}

export async function cdpVersion(port, ms = 800) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** Running = this profile is locked AND its DevTools port answers (not some other program on that port). */
export async function status(inst) {
  const v = await cdpVersion(inst.port);
  return { running: !!v && locked(dataDir(inst.id)), browser: v?.Browser ?? null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Starts the instance as a normal, visible window (never headless). Returns the DevTools port. */
export async function start(id, { url } = {}) {
  const inst = get(id);
  if (!inst) throw new UserError(`No instance "${id}". Create it first: browserpit new ${id}`);
  const dir = dataDir(id);
  if ((await status(inst)).running) return inst.port;
  if (locked(dir)) throw new UserError(`"${id}" is open in a window without remote control – close that window and try again.`);
  if (!(await portFree(inst.port))) throw new UserError(`Port ${inst.port} is used by another program.`);
  const exe = findExecutable(inst.engine);
  if (!exe) {
    throw new UserError(inst.engine === 'auto' || inst.engine === 'chromium'
      ? 'No Chrome, Edge or Chromium found. Install Chrome, or run: npx playwright install chromium'
      : `${inst.engine === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} not found – pick another engine.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const first = !fs.existsSync(path.join(dir, 'Default'));
  const welcome = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>${esc(inst.name)} · browserpit</title><body style="margin:0;font:16px system-ui;background:#111315;color:#eee;display:grid;place-items:center;height:100vh"><div style="border-left:6px solid ${inst.color};padding:8px 20px"><div style="font-size:34px;font-weight:700">${esc(inst.name)}</div><div style="opacity:.7">ID <code>${esc(inst.id)}</code> · own cookies, logins and storage · DevTools port ${inst.port}</div></div>`)}`;
  const args = [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${inst.port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync', // Edge would otherwise sign every profile into the Windows account and share data
    '--disable-features=Translate,MediaRouter',
    '--window-size=1280,860',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  args.push(url || (first ? welcome : ''));
  const proc = spawn(exe, args.filter(Boolean), { detached: true, stdio: 'ignore', windowsHide: false });
  proc.on('error', () => {});
  proc.unref();
  for (let i = 0; i < 100; i++) {
    if (await cdpVersion(inst.port, 500)) return inst.port;
    await sleep(200);
  }
  throw new UserError(`"${id}" did not start (no answer on port ${inst.port}).`);
}

/** Closes the browser through DevTools (like the user closing the window – the profile is saved cleanly). */
export async function stop(id) {
  const inst = get(id);
  if (!inst) return;
  const v = await cdpVersion(inst.port);
  if (!v?.webSocketDebuggerUrl || !locked(dataDir(id))) return;
  await new Promise((resolve) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    const done = () => { try { ws.close(); } catch { /* closed */ } resolve(); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    ws.onmessage = done; ws.onerror = done; ws.onclose = done;
    setTimeout(done, 3000);
  });
  for (let i = 0; i < 25 && (await cdpVersion(inst.port, 300)); i++) await sleep(200);
}

export async function list() {
  return Promise.all(load().map(async (i) => ({ ...i, ...(await status(i)), dir: dataDir(i.id) })));
}

/** Path of Playwright MCP's CLI (installed with this package). */
export function playwrightMcpCli() {
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}
