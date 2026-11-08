import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { STAGE, handoff } from '../lib/handoff.js';
import { Analyst } from '../lib/agents/analyst.js';
import { addr, dexPair, freshTestState, scoutReport } from './helpers.js';

const POOL = addr(1);
const filtered = (pairOverrides = {}, holders = 4000) => {
  const r = scoutReport(dexPair({ mint: addr(9), pool: POOL, ...pairOverrides }));
  return handoff({ ...r, safety: { holders } }, 'filter', STAGE.FILTERED);
};
const gecko = (h1) => ({ pools: async ([a]) => new Map([[a, { address: a, transactions: { h1, m5: { buyers: 90 } } }]]) });
const noSmart = { enabled: false };

test('a strong coin scores 70+ and is handed to the Executor', async () => {
  const analyst = new Analyst({ cfg: DEFAULT_CONFIG, gecko: gecko({ buyers: 900, sellers: 400 }), smart: noSmart });
  const res = await analyst.run(filtered(), freshTestState());
  assert.equal(res.verdict, 'pass');
  assert.equal(res.candidate.stage, STAGE.ANALYZED);
  // momentum 64, unique buyers 85, buy/sell 100, holder growth 94, liq/mcap 42; smart wallets n/a -> mean of 5
  assert.equal(res.score, 76.9);
  assert.equal(res.components.smartWallets.score, null);
  assert.equal(res.components.buySellRatio.ratio, 2.25);
});

test('a weak coin is killed with its component scores', async () => {
  const analyst = new Analyst({ cfg: DEFAULT_CONFIG, gecko: gecko({ buyers: 60, sellers: 120 }), smart: noSmart });
  const res = await analyst.run(filtered({ pc: { h1: -8, m5: -3 } }), freshTestState());
  assert.equal(res.verdict, 'kill');
  assert.equal(res.reasons[0].rule, 'score_below_pass');
  assert.ok(res.score < 70);
});

test('smart wallets count when a list is configured', async () => {
  const smart = { enabled: true, holdersOf: () => ['alpha', 'beta'] };
  const analyst = new Analyst({ cfg: DEFAULT_CONFIG, gecko: gecko({ buyers: 900, sellers: 400 }), smart });
  const res = await analyst.run(filtered(), freshTestState());
  assert.equal(res.components.smartWallets.score, 80);
  assert.deepEqual(res.components.smartWallets.wallets, ['alpha', 'beta']);
});

test('holder growth uses real snapshots once the desk has watched the coin for 10+ minutes', async () => {
  const analyst = new Analyst({ cfg: DEFAULT_CONFIG, gecko: gecko({ buyers: 900, sellers: 400 }), smart: noSmart });
  const state = freshTestState();
  const cand = filtered({}, 4400);
  state.holders[cand.mint] = [[Date.now() - 30 * 60_000, 4000]]; // +10% in 30 min = 20%/h
  const res = await analyst.run(cand, state);
  assert.equal(res.components.holderGrowth.score, 100);
  assert.equal(res.components.holderGrowth.growthPctPerHour, 20);
});

test('too little data is a retryable kill, not a guess', async () => {
  const broken = { pools: async () => { throw new Error('HTTP 429'); } };
  const analyst = new Analyst({ cfg: DEFAULT_CONFIG, gecko: broken, smart: noSmart });
  const res = await analyst.run(filtered({}, 0), freshTestState());
  assert.equal(res.verdict, 'kill');
  assert.equal(res.reasons[0].rule, 'insufficient_data');
  assert.equal(res.reasons[0].retry, true);
});
