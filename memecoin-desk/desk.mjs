#!/usr/bin/env node
// Memecoin desk, headless runner for overnight paper sessions.
//
//   node desk.mjs                 run until Ctrl+C (dashboard on http://localhost:8787)
//   node desk.mjs --hours 9       stop by itself after 9 hours and write a report
//   node desk.mjs --report        print the report for the saved paper account and exit
//   node desk.mjs --fresh         start a new paper account (old state is backed up)
//   node desk.mjs --once          run a single cycle and exit (smoke test)
//   node desk.mjs --flatten       close open positions at market when stopping
//   node desk.mjs --port 0        disable the local dashboard
//
// Settings: config.local.json next to this file (same shape as lib/config.js), or env RPC_URL.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desk } from './lib/desk.js';
import { buildReport } from './lib/report.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'paper-state.json');

// ---------- args & config ----------
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
let local = {};
const localPath = path.join(ROOT, 'config.local.json');
if (fs.existsSync(localPath)) local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
if (process.env.RPC_URL) local = { ...local, rpc: { ...(local.rpc || {}), url: process.env.RPC_URL } };
const usingPublicRpc = !(local.rpc?.url) || local.rpc.url.includes('api.mainnet-beta.solana.com');

// ---------- storage ----------
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
if (args.fresh && fs.existsSync(STATE_FILE)) fs.renameSync(STATE_FILE, path.join(STATE_DIR, `paper-state.${Date.now()}.bak.json`));
const store = {
  async load() {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
  },
  async save(state) {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  },
};

// ---------- log sinks ----------
const day = (t) => t.slice(0, 10);
const jsonlSink = (e) => fs.appendFileSync(path.join(LOG_DIR, `desk-${day(e.t)}.jsonl`), `${JSON.stringify(e)}\n`);
const csvSink = (e) => {
  if (e.type !== 'kill') return;
  const file = path.join(LOG_DIR, `kills-${day(e.t)}.csv`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'time,agent,symbol,mint,rules,details,recheck_in\n');
  const q = (s) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  fs.appendFileSync(file, `${[e.t, e.agent, q(e.symbol), e.mint, q(e.reasons.map((r) => r.rule).join(' ')), q(e.reasons.map((r) => r.detail).join('; ')), e.recheckIn].join(',')}\n`);
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => paint(31, s);
const green = (s) => paint(32, s);
const yellow = (s) => paint(33, s);
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const tag = (s) => bold(s.padEnd(8));
const time = (e) => dim(new Date(e.t).toTimeString().slice(0, 8));
const px = (x) => (Number.isFinite(x) ? (x < 0.001 ? x.toExponential(3) : x.toPrecision(4)) : '–');

function consoleSink(e) {
  let line;
  switch (e.type) {
    case 'start':
      line = `${tag('DESK')} ${e.resumed ? 'resumed' : 'new'} paper account · ${e.cashSol} SOL cash · ${e.open} open · RPC ${e.rpc} · ${e.smartWallets} smart wallets`;
      break;
    case 'scout':
      line = `${tag('SCOUT')} cycle ${e.cycle} · ${e.discovered} discovered → ${bold(e.inWindow)} in window ${dim(`(${e.tooOld} too old, ${e.tooYoung} too young, ${e.mcapLow} mcap low, ${e.mcapHigh} mcap high, ${e.noSolPair} no SOL pair)`)}${e.errors?.length ? yellow(` ⚠ ${e.errors[0]}`) : ''}`;
      break;
    case 'kill': {
      const extra = e.agent === 'analyst' && e.components ? dim(` [${Object.entries(e.components).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v.score ?? '–'}`).join(' · ')}]`) : '';
      line = `${tag(e.agent.toUpperCase())} ${red('✗')} ${bold(e.symbol)} ${e.reasons.map((r) => r.detail).join(' · ')}${extra} ${dim(`(recheck ${e.recheckIn})`)}`;
      break;
    }
    case 'handoff':
      if (e.from === 'scout') return;
      if (e.from === 'filter') line = `${tag('FILTER')} ${green('✓')} ${bold(e.symbol)} clean ${dim(`(top10 ${e.safety.top10Pct}% · dev ${e.safety.devPct ?? '?'}% · LP ${e.safety.lpLockedPct}% locked · launch bundle ${e.safety.bundle?.pct ?? '?'}%)`)} → analyst`;
      else if (e.from === 'analyst') line = `${tag('ANALYST')} ${green('✓')} ${bold(e.symbol)} score ${bold(e.score)} → executor`;
      else if (e.from === 'executor') line = `${tag('EXECUTOR')} ${bold(e.symbol)} ticket ${e.sizeSol} SOL (${e.sizePctOfEquity}% of equity, impact ${e.impactPct}%) → risk`;
      else if (e.from === 'risk') line = `${tag('RISK')} ${bold(e.symbol)} stop armed at ${px(e.stopPrice)} SOL, trail from ${px(e.trailActivatePrice)} → executor`;
      break;
    case 'entry':
      line = `${tag('ENTRY')} ${green('▲')} ${bold(e.symbol)} ${e.sizeSol} SOL @ ${px(e.entryPrice)} SOL · score ${e.score} · equity ${e.equitySol} SOL ${dim(e.pair || '')}`;
      break;
    case 'exit':
      line = `${tag('EXIT')} ${e.pnlSol >= 0 ? green('▼') : red('▼')} ${bold(e.symbol)} ${e.reason} ${(e.pnlSol >= 0 ? green : red)(`${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct}% (${e.pnlSol} SOL)`)} after ${e.holdMin}m${e.equitySol ? ` · equity ${e.equitySol} SOL` : ''}`;
      break;
    case 'risk':
      line = `${tag('RISK')} ${bold(e.symbol)} ${e.event === 'trail_on' ? `trailing stop on at +${e.gainPct}%` : `${e.event} (${e.minutes}m without a quote)`}`;
      break;
    case 'cycle':
      line = dim(`${'CYCLE'.padEnd(8)} ${e.cycle} done in ${(e.ms / 1000).toFixed(1)}s · ${e.candidates} candidates (${e.cooling} cooling, ${e.held} held) · equity ${e.equitySol} SOL · ${e.open} open · SOL $${e.solUsd}`);
      break;
    case 'smart_wallets':
      line = `${tag('ANALYST')} smart-wallet holdings refreshed (${e.refreshed}/${e.wallets})${e.errors.length ? yellow(` ⚠ ${e.errors[0]}`) : ''}`;
      break;
    case 'error':
      line = `${tag('ERROR')} ${yellow(`${e.agent}${e.symbol ? ` ${e.symbol}` : ''}: ${e.message}`)}`;
      break;
    case 'retry':
      if (!args.verbose) return;
      line = dim(`${'RETRY'.padEnd(8)} ${e.reason} on ${e.url}, waiting ${(e.wait / 1000).toFixed(1)}s`);
      break;
    case 'stop':
      line = `${tag('DESK')} stopped after ${e.cycles} cycles · equity ${e.equitySol} SOL`;
      break;
    default:
      return;
  }
  console.log(`${time(e)} ${line}`);
}

// ---------- run ----------
const desk = new Desk({ config: local, store, sinks: [jsonlSink, csvSink, consoleSink] });
await desk.init({ fresh: args.fresh });
if (desk.resumed) replayRecentLog(desk);

if (args.report) {
  console.log(buildReport({ state: desk.state, cfg: desk.cfg, startedAt: desk.state.createdAt }));
  process.exit(0);
}

console.log(bold('\nMemecoin desk · PAPER MODE · Scout → Filter → Analyst → Executor → Risk → Logger'));
if (usingPublicRpc) console.log(yellow('Using the public Solana RPC (slow, rate-limited). For overnight runs set RPC_URL or rpc.url in config.local.json (e.g. a free Helius key).'));

if (args.once) {
  await desk.runCycle();
  await desk.riskTick();
  console.log(buildReport({ state: desk.state, cfg: desk.cfg, startedAt: Date.now(), recentKills: desk.recent.kills.slice().reverse() }));
  process.exit(0);
}

const sessionStart = Date.now();
let server;
const port = args.port === undefined ? 8787 : Number(args.port);
if (port > 0) server = startDashboard(port);
desk.start();

let stopping = false;
async function shutdown(why) {
  if (stopping) return;
  stopping = true;
  console.log(dim(`\nStopping (${why})…`));
  // let the in-flight cycle finish, but never hang on a slow RPC call
  await Promise.race([desk.stop(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  await desk.save();
  if (args.flatten) await desk.flatten('session end (flatten)').catch((err) => console.log(yellow(`flatten failed: ${err.message}`)));
  const report = buildReport({ state: desk.state, cfg: desk.cfg, startedAt: sessionStart, recentKills: desk.recent.kills.slice().reverse() });
  const file = path.join(LOG_DIR, `report-${new Date(sessionStart).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
  fs.writeFileSync(file, report);
  console.log(`\n${report}\n\nReport saved to ${path.relative(process.cwd(), file)}`);
  server?.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (args.hours) {
  const ms = Number(args.hours) * 3_600_000;
  console.log(dim(`Will stop by itself at ${new Date(Date.now() + ms).toLocaleString()}.`));
  setTimeout(() => shutdown(`${args.hours}h elapsed`), ms);
}

// ---------- local dashboard (same index.html as GitHub Pages, in viewer mode) ----------
function startDashboard(listenPort) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...desk.snapshot(), runner: true }));
      return;
    }
    if (url.pathname === '/api/report') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(buildReport({ state: desk.state, cfg: desk.cfg, startedAt: sessionStart, recentKills: desk.recent.kills.slice().reverse() }));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    const allowed = file === path.join(ROOT, 'index.html') || file.startsWith(path.join(ROOT, 'lib') + path.sep);
    if (!allowed || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  srv.on('error', (err) => console.log(yellow(`Dashboard not started (${err.code === 'EADDRINUSE' ? `port ${listenPort} is busy; use --port` : err.message}).`)));
  srv.listen(listenPort, '127.0.0.1', () => console.log(`Dashboard: ${bold(`http://localhost:${listenPort}`)}`));
  return srv;
}

// After a restart, refill the dashboard's kill log and activity feed from the newest JSONL files.
function replayRecentLog(d) {
  const files = fs.readdirSync(LOG_DIR).filter((f) => /^desk-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
  const lines = files.flatMap((f) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')).filter(Boolean).slice(-600);
  for (const line of lines) {
    try {
      d.remember(JSON.parse(line));
    } catch {
      // skip a partially written line
    }
  }
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}
