#!/usr/bin/env node
// browserpit – isolated, visible browser instances with IDs; each one usable by Claude as an MCP server.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as core from '../lib/core.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) { console.error(`browserpit needs Node.js 22 or newer (you have ${process.versions.node}).`); process.exit(1); }

const HELP = `browserpit ${pkg.version} – separate, visible browsers with IDs, for you and for Claude

Usage
  npx browserpit                    open the manager app
  npx browserpit new <name> [--engine auto|chrome|msedge|chromium]
  npx browserpit open <id> [url]    open an instance window (created if missing)
  npx browserpit close <id>
  npx browserpit list
  npx browserpit delete <id>        remove an instance and all its data
  npx browserpit mcp <id> [...]     MCP server for Claude, driving that window
                                    (extra args go to Playwright MCP)

Give Claude Code a browser
  claude mcp add browser-work -- npx -y browserpit mcp work

Options
  --port <n>     manager port (default 4319)
  --no-open      do not open the manager window
  -v, --version  -h, --help

Data: ${core.HOME} (BROWSERPIT_HOME to change). Each ID has its own profile folder.`;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v ?? ''; };
const has = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const fail = (m) => { console.error(m); process.exit(1); };

async function main() {
  const [cmd, ...rest] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return console.log(HELP);
  if (cmd === '-v' || cmd === '--version') return console.log(pkg.version);

  if (cmd === 'mcp') {
    // stdout belongs to the MCP protocol – everything else goes to stderr
    const [id, ...extra] = rest;
    if (!id) fail('Usage: browserpit mcp <id>');
    const sid = core.slug(id);
    if (!core.get(sid)) { core.create({ id: sid, name: id }); console.error(`[browserpit] created instance "${sid}"`); }
    const port = await core.start(sid);
    console.error(`[browserpit] "${sid}" on port ${port} – profile ${core.dataDir(sid)}`);
    const child = spawn(process.execPath, [core.playwrightMcpCli(), '--cdp-endpoint', `http://127.0.0.1:${port}`, ...extra], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
    return;
  }
  if (cmd === 'new' || cmd === 'create') {
    const engine = flag('--engine') ?? 'auto';
    const name = rest.filter((a) => a !== '--engine' && a !== engine).join(' ');
    if (!name) fail('Usage: browserpit new <name>');
    const i = core.create({ name, engine });
    return console.log(`created "${i.id}" (port ${i.port})\n  open:   npx browserpit open ${i.id}\n  claude: claude mcp add browser-${i.id} -- npx -y browserpit mcp ${i.id}`);
  }
  if (cmd === 'open' || cmd === 'start') {
    const [id, url] = rest;
    if (!id) fail('Usage: browserpit open <id> [url]');
    const sid = core.slug(id);
    if (!core.get(sid)) core.create({ id: sid, name: id });
    const port = await core.start(sid, { url });
    return console.log(`"${sid}" is open (DevTools port ${port}).`);
  }
  if (cmd === 'close' || cmd === 'stop') { if (!rest[0]) fail('Usage: browserpit close <id>'); await core.stop(core.slug(rest[0])); return console.log('closed'); }
  if (cmd === 'delete' || cmd === 'rm') { if (!rest[0]) fail('Usage: browserpit delete <id>'); await core.remove(core.slug(rest[0])); return console.log('deleted'); }
  if (cmd === 'list' || cmd === 'ls') {
    const l = await core.list();
    if (!l.length) return console.log('No instances. Create one: npx browserpit new <name>');
    for (const i of l) console.log(`${i.running ? '●' : '○'} ${i.id.padEnd(20)} ${i.name.padEnd(24)} ${i.engine.padEnd(8)} port ${i.port}`);
    return;
  }
  if (cmd && !cmd.startsWith('-')) fail(`Unknown command: ${cmd}\n\n${HELP}`);

  // manager app
  const port = Number(flag('--port') ?? process.env.BROWSERPIT_PORT ?? 4319);
  const noOpen = has('--no-open');
  if (argv.length) fail(`Unknown argument: ${argv[0]}\n\n${HELP}`);
  const { serve, ping, openApp } = await import('../lib/server.js');
  const url = `http://127.0.0.1:${port}/`;
  if (await ping(port)) { if (!noOpen) openApp(url); console.log(`browserpit is already running: ${url}`); return; }
  await serve(port, pkg.version);
  console.log(`browserpit ${pkg.version} – ${url}\nData: ${core.HOME}\nCtrl+C stops the manager; open browser windows stay open.`);
  if (!noOpen) openApp(url);
}

main().catch((e) => fail(e instanceof core.UserError ? e.message : e.stack || String(e)));
