// The desk: six agents in a fixed chain with hard handoffs.
//   Scout -> Filter -> Analyst -> Executor (ticket) -> Risk (stop armed) -> Executor (fill) -> Logger
// Risk also runs its own faster loop over open positions (stop / trailing stop / drained pool).
import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { Http } from './http.js';
import { Rpc } from './solana.js';
import { DexScreener, GeckoTerminal, RugCheck } from './sources.js';
import { SmartWallets } from './smart-wallets.js';
import { Scout } from './agents/scout.js';
import { Filter } from './agents/filter.js';
import { Analyst } from './agents/analyst.js';
import { Executor, PaperBroker, markEquity } from './agents/executor.js';
import { Risk } from './agents/risk.js';
import { Logger } from './agents/logger.js';
import { num, round } from './util.js';

export const AGENTS = ['scout', 'filter', 'analyst', 'executor', 'risk', 'logger'];

export function freshState(cfg) {
  return {
    version: 1,
    createdAt: Date.now(),
    cycle: 0,
    solUsd: null,
    portfolio: { startingSol: cfg.paper.startingSol, cashSol: cfg.paper.startingSol, positions: {}, closed: [] },
    watch: {},
    cooldowns: {},
    bundles: {},
    holders: {},
    lastExit: {},
    stats: { cycles: 0, candidates: 0, kills: {}, killsByRule: {}, passes: { filter: 0, analyst: 0 }, entries: 0, exits: 0, errors: 0 },
  };
}

export class Desk {
  constructor({ config = {}, store, sinks = [], fetchImpl } = {}) {
    this.cfg = mergeConfig(DEFAULT_CONFIG, config);
    if (this.cfg.mode !== 'paper') throw new Error('Only paper mode exists in this build.');
    this.store = store;
    this.logger = new Logger({ sinks: [...sinks, (e) => this.remember(e)] });
    this.recent = { events: [], kills: [] };
    this.http = new Http({
      intervals: this.cfg.http.hosts,
      timeoutMs: this.cfg.http.timeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
      onRetry: (r) => this.logger.emit('retry', r),
    });
    this.rpc = new Rpc(this.http, this.cfg.rpc);
    this.dex = new DexScreener(this.http);
    this.gecko = new GeckoTerminal(this.http);
    this.rug = new RugCheck(this.http);
    this.smart = new SmartWallets({ rpc: this.rpc, cfg: this.cfg });
    this.scout = new Scout({ cfg: this.cfg, dex: this.dex, gecko: this.gecko });
    this.filter = new Filter({ cfg: this.cfg, rpc: this.rpc, rug: this.rug });
    this.analyst = new Analyst({ cfg: this.cfg, gecko: this.gecko, smart: this.smart });
    this.executor = new Executor({ cfg: this.cfg, broker: new PaperBroker(this.cfg.paper), dex: this.dex });
    this.risk = new Risk({ cfg: this.cfg });
    this.running = false;
    this.timers = new Set();
    this.lastCycle = null;
    this.ticks = 0;
  }

  async init({ fresh = false } = {}) {
    const saved = fresh ? null : await this.store?.load();
    this.state = saved?.version === 1 ? saved : freshState(this.cfg);
    this.resumed = Boolean(saved && !fresh);
    return this;
  }

  remember(e) {
    if (e.type === 'retry') return;
    this.recent.events.push(e);
    if (this.recent.events.length > 400) this.recent.events.splice(0, 100);
    if (e.type === 'kill') {
      this.recent.kills.push(e);
      if (this.recent.kills.length > 300) this.recent.kills.splice(0, 100);
    }
  }

  // ---------- main chain ----------
  async runCycle() {
    const st = this.state;
    const L = this.logger;
    const t0 = Date.now();
    st.cycle++;
    st.stats.cycles++;

    const sw = await this.smart.refreshIfDue();
    if (sw) L.emit('smart_wallets', sw);

    let scout;
    try {
      scout = await this.scout.run(st);
    } catch (err) {
      st.stats.errors++;
      L.emit('error', { agent: 'scout', message: err.message });
      return;
    }
    if (Number.isFinite(scout.solUsd)) st.solUsd = scout.solUsd;
    L.emit('scout', { cycle: st.cycle, ...scout.stats, candidates: scout.reports.map((r) => r.symbol), errors: scout.errors.slice(0, 3) });

    const tally = { candidates: scout.reports.length, held: 0, cooling: 0, filterKills: 0, analystKills: 0, passed: 0, entries: 0 };
    for (const report of scout.reports) {
      if (this.stopping) break;
      if (st.portfolio.positions[report.mint]) {
        tally.held++;
        continue;
      }
      const cd = st.cooldowns[report.mint];
      if (cd && (cd.permanent || cd.until > Date.now())) {
        tally.cooling++;
        continue;
      }
      st.stats.candidates++;
      L.handoff('scout', 'filter', report, { mcapUsd: round(report.mcapUsd, 0), ageMin: round(report.ageMin, 0), sources: report.sources });

      // Filter
      let f;
      try {
        f = await this.filter.run(report, st);
      } catch (err) {
        st.stats.errors++;
        L.emit('error', { agent: 'filter', mint: report.mint, symbol: report.symbol, message: err.message });
        continue;
      }
      if (f.verdict === 'kill') {
        tally.filterKills++;
        this.recordKill('filter', report, f.reasons, { metrics: f.metrics, stages: f.stagesRun }, f.ttlMin);
        continue;
      }
      st.stats.passes.filter++;
      L.handoff('filter', 'analyst', f.candidate, { safety: f.metrics });

      // Analyst
      let a;
      try {
        a = await this.analyst.run(f.candidate, st);
      } catch (err) {
        st.stats.errors++;
        L.emit('error', { agent: 'analyst', mint: report.mint, symbol: report.symbol, message: err.message });
        continue;
      }
      if (a.verdict === 'kill') {
        tally.analystKills++;
        const retry = a.reasons.every((r) => r.retry);
        this.recordKill('analyst', f.candidate, a.reasons, { score: a.score, components: a.components }, retry ? this.cfg.filter.unverifiableRetryMinutes : this.cfg.filter.recheckMinutes);
        continue;
      }
      tally.passed++;
      st.stats.passes.analyst++;
      L.handoff('analyst', 'executor', a.candidate, { score: a.score, components: a.components });

      // Executor builds the ticket, Risk arms the stop, then (and only then) the Executor fills.
      const t = await this.executor.prepare(a.candidate, st.portfolio, { solUsd: st.solUsd, lastExit: st.lastExit });
      if (t.verdict === 'kill') {
        this.recordKill('executor', a.candidate, t.reasons, { score: a.score }, this.cfg.filter.unverifiableRetryMinutes);
        continue;
      }
      const o = t.ticket.order;
      L.handoff('executor', 'risk', t.ticket, { sizeSol: round(o.sizeSol, 4), sizePctOfEquity: round(o.sizePctOfEquity, 2), expectedPrice: o.expectedPrice, impactPct: round(o.impactPct, 2) });
      const r = this.risk.arm(t.ticket, st.portfolio);
      if (r.verdict === 'kill') {
        this.recordKill('risk', t.ticket, r.reasons, { score: a.score }, this.cfg.filter.unverifiableRetryMinutes);
        continue;
      }
      L.handoff('risk', 'executor', r.ticket, { stopPrice: r.ticket.risk.stopPrice, trailActivatePrice: r.ticket.risk.trailActivatePrice });
      const pos = this.executor.fill(r.ticket, st.portfolio);
      st.stats.entries++;
      tally.entries++;
      L.emit('entry', {
        mint: pos.mint,
        symbol: pos.symbol,
        pair: pos.pairUrl,
        score: pos.score,
        sizeSol: round(pos.sizeSol, 4),
        entryPrice: pos.entryPrice,
        entryPriceUsd: pos.entryPriceUsd,
        stopPrice: pos.stopPrice,
        trailActivatePrice: pos.trailActivatePrice,
        impactPct: round(pos.impactPct, 2),
        trail: pos.trail,
        equitySol: round(markEquity(st.portfolio), 4),
      });
      await this.save();
    }

    this.prune();
    const pf = st.portfolio;
    this.lastCycle = { at: Date.now(), ms: Date.now() - t0, ...tally, scout: scout.stats };
    L.emit('cycle', { cycle: st.cycle, ms: Date.now() - t0, ...tally, open: Object.keys(pf.positions).length, cashSol: round(pf.cashSol, 4), equitySol: round(markEquity(pf), 4), solUsd: round(st.solUsd, 2) });
    await this.save();
  }

  recordKill(agent, item, reasons, extra, ttlMin) {
    const st = this.state;
    st.stats.kills[agent] = (st.stats.kills[agent] || 0) + 1;
    for (const r of reasons) st.stats.killsByRule[r.rule] = (st.stats.killsByRule[r.rule] || 0) + 1;
    const permanent = ttlMin === Infinity;
    if (ttlMin) st.cooldowns[item.mint] = { symbol: item.symbol, agent, rules: reasons.map((r) => r.rule), at: Date.now(), permanent, until: permanent ? null : Date.now() + ttlMin * 60_000 };
    this.logger.kill(agent, item, reasons, { ...extra, recheckIn: permanent ? 'never' : ttlMin ? `${ttlMin}m` : 'next cycle' });
  }

  // ---------- risk loop ----------
  async riskTick() {
    const st = this.state;
    const positions = Object.values(st.portfolio.positions);
    if (!positions.length) return;
    this.ticks++;
    let pairs;
    try {
      pairs = await this.dex.pairs(positions.map((p) => p.pairAddress));
    } catch (err) {
      this.logger.emit('error', { agent: 'risk', message: `price refresh failed: ${err.message}` });
      this.flagStale(positions);
      return;
    }
    const byAddress = new Map(pairs.map((p) => [p.pairAddress, p]));
    let changed = false;
    for (const pos of positions) {
      const p = byAddress.get(pos.pairAddress);
      const priceSol = num(p?.priceNative, NaN);
      if (!(priceSol > 0)) {
        this.flagStale([pos]);
        continue;
      }
      const quote = { priceSol, priceUsd: num(p.priceUsd, NaN), liquidityUsd: num(p.liquidity?.usd), liquidityQuote: num(p.liquidity?.quote) };
      const d = this.risk.evaluate(pos, quote);
      if (d.events.includes('trail_on')) {
        this.logger.emit('risk', { event: 'trail_on', mint: pos.mint, symbol: pos.symbol, gainPct: round(((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100, 2), stopPrice: pos.stopPrice });
        changed = true;
      }
      if (d.exit) {
        const trade = this.executor.close(pos, quote, d.reason, st.portfolio, st.solUsd);
        st.lastExit[pos.mint] = Date.now();
        st.stats.exits++;
        changed = true;
        this.logger.emit('exit', {
          mint: trade.mint,
          symbol: trade.symbol,
          reason: trade.exitReason,
          pnlSol: round(trade.pnlSol, 4),
          pnlPct: round(trade.pnlPct, 2),
          peakPct: round(trade.peakPct, 2),
          holdMin: round(trade.holdMin, 1),
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          equitySol: round(markEquity(st.portfolio), 4),
        });
      }
    }
    if (changed || this.ticks % 4 === 0) await this.save();
  }

  flagStale(positions) {
    const limit = this.cfg.risk.staleQuoteMinutes * 60_000;
    for (const pos of positions) {
      if (!pos.staleWarned && Date.now() - pos.lastQuoteAt > limit) {
        pos.staleWarned = true;
        this.logger.emit('risk', { event: 'stale_quote', mint: pos.mint, symbol: pos.symbol, minutes: round((Date.now() - pos.lastQuoteAt) / 60_000, 0) });
      }
    }
  }

  // Close everything at the current price (used by --flatten / the Flatten button).
  async flatten(reason = 'manual flatten') {
    const positions = Object.values(this.state.portfolio.positions);
    if (!positions.length) return [];
    const pairs = await this.dex.pairs(positions.map((p) => p.pairAddress));
    const byAddress = new Map(pairs.map((p) => [p.pairAddress, p]));
    const trades = [];
    for (const pos of positions) {
      const p = byAddress.get(pos.pairAddress);
      const quote = p
        ? { priceSol: num(p.priceNative), priceUsd: num(p.priceUsd), liquidityUsd: num(p.liquidity?.usd), liquidityQuote: num(p.liquidity?.quote) }
        : { priceSol: pos.lastPrice, priceUsd: pos.lastPriceUsd, liquidityUsd: pos.lastLiquidityUsd, liquidityQuote: 0 };
      const trade = this.executor.close(pos, quote, reason, this.state.portfolio, this.state.solUsd);
      this.state.lastExit[pos.mint] = Date.now();
      this.state.stats.exits++;
      trades.push(trade);
      this.logger.emit('exit', { mint: trade.mint, symbol: trade.symbol, reason, pnlSol: round(trade.pnlSol, 4), pnlPct: round(trade.pnlPct, 2), holdMin: round(trade.holdMin, 1) });
    }
    await this.save();
    return trades;
  }

  // ---------- housekeeping ----------
  prune() {
    const st = this.state;
    const now = Date.now();
    const horizon = (this.cfg.scout.maxAgeHours + 24) * 3_600_000;
    for (const [mint, cd] of Object.entries(st.cooldowns)) if ((!cd.permanent && cd.until < now) || now - cd.at > horizon) delete st.cooldowns[mint];
    for (const [mint, b] of Object.entries(st.bundles)) if (now - (b.checkedAt || 0) > horizon) delete st.bundles[mint];
    for (const [mint, list] of Object.entries(st.holders)) if (!st.watch[mint] && now - list[list.length - 1][0] > 3 * 3_600_000) delete st.holders[mint];
    for (const [mint, t] of Object.entries(st.lastExit)) if (now - t > horizon) delete st.lastExit[mint];
    if (st.portfolio.closed.length > 1000) st.portfolio.closed.splice(0, st.portfolio.closed.length - 1000);
  }

  async save() {
    try {
      await this.store?.save(this.state);
    } catch (err) {
      this.logger.emit('error', { agent: 'logger', message: `state save failed: ${err.message}` });
    }
  }

  // ---------- scheduling ----------
  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.startedAt = Date.now();
    this.logger.emit('start', { mode: 'paper', resumed: this.resumed, cashSol: round(this.state.portfolio.cashSol, 4), open: Object.keys(this.state.portfolio.positions).length, rpc: redactRpc(this.cfg.rpc.url), smartWallets: this.smart.wallets.length });
    this.cycleLoop = this.loop(() => this.runCycle(), this.cfg.loop.cycleSeconds);
    this.riskLoop = this.loop(() => this.riskTick(), this.cfg.loop.riskTickSeconds);
  }

  async loop(fn, seconds) {
    while (this.running) {
      const t0 = Date.now();
      try {
        await fn();
      } catch (err) {
        this.state.stats.errors++;
        this.logger.emit('error', { agent: 'desk', message: err.stack || err.message });
      }
      await this.sleep(t0 + seconds * 1000 - Date.now());
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      if (!this.running) return resolve();
      const timer = setTimeout(() => {
        this.timers.delete(entry);
        resolve();
      }, Math.max(0, ms));
      const entry = { timer, resolve };
      this.timers.add(entry);
    });
  }

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    for (const { timer, resolve } of this.timers) {
      clearTimeout(timer);
      resolve();
    }
    this.timers.clear();
    await Promise.allSettled([this.cycleLoop, this.riskLoop]);
    this.logger.emit('stop', { cycles: this.state.stats.cycles, equitySol: round(markEquity(this.state.portfolio), 4) });
    await this.save();
  }

  // ---------- views ----------
  snapshot() {
    const st = this.state;
    const pf = st.portfolio;
    const equity = markEquity(pf);
    const realized = pf.closed.reduce((s, t) => s + t.pnlSol, 0);
    const wins = pf.closed.filter((t) => t.pnlSol > 0).length;
    return {
      mode: 'paper',
      running: this.running,
      startedAt: this.startedAt || null,
      now: Date.now(),
      cycle: st.cycle,
      solUsd: st.solUsd,
      rpc: redactRpc(this.cfg.rpc.url),
      smartWallets: this.smart.wallets.length,
      portfolio: {
        startingSol: pf.startingSol,
        cashSol: pf.cashSol,
        equitySol: equity,
        pnlSol: equity - pf.startingSol,
        pnlPct: ((equity - pf.startingSol) / pf.startingSol) * 100,
        realizedSol: realized,
        trades: pf.closed.length,
        winRatePct: pf.closed.length ? (wins / pf.closed.length) * 100 : null,
        open: Object.values(pf.positions).map((p) => ({
          ...p,
          pnlPct: ((p.lastPrice - p.entryPrice) / p.entryPrice) * 100,
          valueSol: p.tokens * p.lastPrice,
        })),
        closed: pf.closed.slice(-60).reverse(),
      },
      stats: st.stats,
      lastCycle: this.lastCycle,
      watchlist: Object.keys(st.watch).length,
      cooling: Object.keys(st.cooldowns).length,
      kills: this.recent.kills.slice(-150).reverse(),
      events: this.recent.events.filter((e) => e.type !== 'handoff' || e.from !== 'scout').slice(-200).reverse(),
      rules: rulesSummary(this.cfg),
    };
  }
}

export function redactRpc(url = '') {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.search ? ' (key hidden)' : ''}`;
  } catch {
    return 'invalid url';
  }
}

export function rulesSummary(cfg) {
  const { scout: s, filter: f, analyst: a, executor: e, risk: r } = cfg;
  return {
    scout: `pairs ${s.minAgeMinutes}m–${s.maxAgeHours}h old, mcap $${s.minMcapUsd / 1e3}k–$${s.maxMcapUsd / 1e6}M (DexScreener)`,
    filter: `kill: mint/freeze not revoked, LP <${f.minLpLockedPct}% burned/locked, liq <$${f.minLiquidityUsd / 1e3}k, 1h vol <$${f.minVolume1hUsd / 1e3}k, top 10 >${f.maxTop10Pct}%, dev >${f.maxDevPct}% or past rugs, bundled launch >${f.maxBundledPct}%, already +${f.maxPriceChange1hPct}% in 1h`,
    analyst: `score 0–100 (momentum, unique buyers, buy/sell, holder growth, liq/mcap, smart wallets); ${a.passScore}+ passes`,
    executor: `max ${e.maxPositionPct}% of equity per trade (paper)`,
    risk: `stop −${r.stopLossPct}% armed before entry; trail at ${r.trailDistancePct}% after +${r.trailActivatePct}%`,
    logger: 'every handoff, kill, entry and exit',
  };
}
