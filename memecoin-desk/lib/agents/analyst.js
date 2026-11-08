// Agent 3 - Analyst. Scores Filter survivors 0-100 on six components; only 70+ is handed to the Executor.
//   momentum       price change 5m/1h/6h + volume acceleration (DexScreener)
//   uniqueBuyers   distinct buying wallets in the last hour (GeckoTerminal, from on-chain swaps)
//   buySellRatio   distinct buyers / distinct sellers, last hour
//   holderGrowth   holder count growth per hour between scans (RugCheck counts), or holders/hour since launch on first sight
//   liqToMcap      pool liquidity / market cap
//   smartWallets   how many wallets from your smart-wallet list hold it (on-chain balances)
import { STAGE, expectStage, handoff } from '../handoff.js';
import { logRamp, num, ramp, round } from '../util.js';

export class Analyst {
  constructor({ cfg, gecko, smart }) {
    this.cfg = cfg;
    this.gecko = gecko;
    this.smart = smart;
  }

  async run(candidate, state) {
    expectStage('analyst', candidate, STAGE.FILTERED);
    const a = this.cfg.analyst;
    const p = candidate.pair;
    const c = {};

    // Momentum: rising but not vertical (the Filter already removed +80%/1h).
    const volAccel = p.volume.h1 > 0 ? (p.volume.m5 * 12) / p.volume.h1 : 0;
    c.momentum = component(
      100 * (0.4 * ramp(p.priceChange.h1, -10, 40) + 0.25 * ramp(p.priceChange.m5, -5, 10) + 0.15 * ramp(p.priceChange.h6, -20, 60) + 0.2 * ramp(volAccel, 0.5, 2)),
      { m5: p.priceChange.m5, h1: p.priceChange.h1, h6: p.priceChange.h6, volAccel: round(volAccel, 2) },
    );

    // Unique buyers and buy/sell ratio from distinct wallets.
    let gt = null;
    try {
      gt = (await this.gecko.pools([p.address])).get(p.address) || null;
    } catch (err) {
      c.uniqueBuyers = missing(`GeckoTerminal: ${err.message}`);
    }
    const tx = gt?.transactions;
    if (tx?.h1) {
      const buyers = num(tx.h1.buyers);
      const sellers = num(tx.h1.sellers);
      c.uniqueBuyers = component(100 * logRamp(buyers, 50, 1500), { buyers1h: buyers, buyers5m: num(tx.m5?.buyers) });
      const ratio = buyers / Math.max(1, sellers);
      c.buySellRatio = component(100 * ramp(ratio, 0.8, 2.0), { buyers1h: buyers, sellers1h: sellers, ratio: round(ratio, 2), source: 'unique wallets' });
    } else {
      c.uniqueBuyers ||= missing('no pool data from GeckoTerminal');
      const { buys, sells } = p.txns.h1;
      const ratio = buys / Math.max(1, sells);
      c.buySellRatio = buys + sells > 0 ? component(100 * ramp(ratio, 0.8, 2.0), { buys1h: buys, sells1h: sells, ratio: round(ratio, 2), source: 'transactions' }) : missing('no 1h transactions');
    }

    // Holder growth.
    const holders = num(candidate.safety?.holders);
    if (holders > 0) {
      const now = Date.now();
      const ref = (state.holders[candidate.mint] || []).find(([t]) => now - t >= 10 * 60_000 && now - t <= 90 * 60_000);
      if (ref && ref[1] > 0) {
        const hours = (now - ref[0]) / 3_600_000;
        const growthPctPerHour = ((holders - ref[1]) / ref[1]) * 100 / hours;
        c.holderGrowth = component(100 * ramp(growthPctPerHour, 0, 15), { holders, growthPctPerHour: round(growthPctPerHour, 2), windowMin: round(hours * 60, 0) });
      } else {
        const perHour = holders / Math.max(0.5, candidate.ageMin / 60);
        c.holderGrowth = component(100 * logRamp(perHour, 20, 1000), { holders, holdersPerHourSinceLaunch: round(perHour, 1) });
      }
    } else {
      c.holderGrowth = missing('no holder count');
    }

    // Liquidity depth relative to valuation.
    const liqRatio = p.liquidityUsd / Math.max(1, candidate.mcapUsd);
    c.liqToMcap = component(100 * ramp(liqRatio, 0.03, 0.15), { ratio: round(liqRatio, 3) });

    // Smart wallets.
    if (this.smart?.enabled) {
      const hits = this.smart.holdersOf(candidate.mint);
      c.smartWallets = component([0, 50, 80, 100][Math.min(3, hits.length)], { count: hits.length, wallets: hits });
    } else {
      c.smartWallets = missing('no smart-wallet list configured');
    }

    // Weighted average over the components that have data.
    let sum = 0;
    let weight = 0;
    for (const [name, comp] of Object.entries(c)) {
      const w = num(a.weights[name], 0);
      if (comp.score == null || w <= 0) continue;
      sum += comp.score * w;
      weight += w;
    }
    const used = Object.values(c).filter((x) => x.score != null).length;
    const score = weight > 0 ? round(sum / weight, 1) : 0;
    const components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.score == null ? { score: null, note: v.note } : { score: round(v.score, 0), ...v.inputs }]));

    if (used < a.minComponents) {
      return { verdict: 'kill', score, components, reasons: [{ rule: 'insufficient_data', detail: `only ${used}/6 score components had data (need ${a.minComponents})`, retry: true }] };
    }
    if (score < a.passScore) {
      return { verdict: 'kill', score, components, reasons: [{ rule: 'score_below_pass', detail: `score ${score} < ${a.passScore}` }] };
    }
    return { verdict: 'pass', score, components, candidate: handoff({ ...candidate, score, components }, 'analyst', STAGE.ANALYZED) };
  }
}

const component = (score, inputs) => ({ score: Math.max(0, Math.min(100, score)), inputs });
const missing = (note) => ({ score: null, note });
