import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { HandoffError, STAGE } from '../lib/handoff.js';
import { Filter } from '../lib/agents/filter.js';
import { addr, dexPair, fakeRpc, freshTestState, launchHistory, rugReport, scoutReport } from './helpers.js';

const MINT = 'BWh8q5etuPwekJ2JEDkbMxMQWy4FysoJ8LEwE3rFpump';
const POOL = addr(1);
const DEV = addr(2);

async function setup({ pair = {}, rug = {}, mintInfo = {}, launch = {} } = {}) {
  const report = scoutReport(dexPair({ mint: MINT, pool: POOL, ...pair }));
  const history = await launchHistory({ mint: MINT, creator: DEV, pool: POOL, ...launch });
  const rpc = fakeRpc({ mintInfo, history });
  const rc = rugReport({ mint: MINT, pool: POOL, creator: DEV, ...rug });
  let rugCalls = 0;
  const filter = new Filter({ cfg: DEFAULT_CONFIG, rpc, rug: { report: async () => (rugCalls++, rc) } });
  return { filter, report, rpc, state: freshTestState(), rugCalls: () => rugCalls };
}

const rules = (res) => res.reasons.map((r) => r.rule);

test('a clean token passes and is handed to the Analyst', async () => {
  const { filter, report, state } = await setup();
  const res = await filter.run(report, state);
  assert.equal(res.verdict, 'pass', JSON.stringify(res.reasons));
  assert.equal(res.candidate.stage, STAGE.FILTERED);
  assert.deepEqual(res.candidate.trail.map((h) => h.agent), ['scout', 'filter']);
  assert.equal(res.metrics.top10Pct, 15); // 10 x 1.5%; the 12% pool vault is not a holder
  assert.equal(res.metrics.bundle.pct, 2); // only the dev buy landed in the creation slot
});

test('market rules kill before any on-chain call is made', async () => {
  const { filter, report, state, rpc, rugCalls } = await setup({ pair: { liqUsd: 30_000, vol: { h1: 20_000 }, pc: { h1: 95 } } });
  const res = await filter.run(report, state);
  assert.deepEqual(rules(res), ['low_liquidity', 'low_volume_1h', 'pumped_1h']);
  assert.equal(rpc.calls.getMint, 0);
  assert.equal(rugCalls(), 0);
  assert.equal(res.ttlMin, DEFAULT_CONFIG.filter.recheckMinutes);
});

test('kills when mint or freeze authority is still set', async () => {
  const { filter, report, state } = await setup({ mintInfo: { mintAuthority: addr(3), freezeAuthority: addr(4) } });
  assert.deepEqual(rules(await filter.run(report, state)), ['mint_authority', 'freeze_authority']);
});

test('kills when the main pool LP is not burned or locked', async () => {
  const { filter, report, state } = await setup({ rug: { lpLockedPct: 40 } });
  assert.deepEqual(rules(await filter.run(report, state)), ['lp_not_locked']);
});

test('kills when the top 10 real wallets hold more than 25%', async () => {
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: addr(40 + i), owner: addr(60 + i), pct: 2.8 }));
  const { filter, report, state } = await setup({ rug: { holders } });
  const res = await filter.run(report, state);
  assert.deepEqual(rules(res), ['top10_concentration']);
  assert.equal(res.metrics.top10Pct, 28);
});

test('kills a dev holding more than 3% and a dev with past rugs (permanently)', async () => {
  const a = await setup({ rug: { creatorBalance: 0.05 * 1e15 } });
  assert.deepEqual(rules(await a.filter.run(a.report, a.state)), ['dev_holding']);
  const b = await setup({ rug: { risks: [{ name: 'Creator history of rugged tokens', level: 'danger' }] } });
  const res = await b.filter.run(b.report, b.state);
  assert.deepEqual(rules(res), ['dev_past_rugs']);
  assert.equal(res.ttlMin, Infinity);
});

test('kills a bundled launch: >10% bought in the creation slot (migration and pool ignored)', async () => {
  const bundle = [3.5, 3.5, 3.5].map((pct, i) => ({ owner: addr(80 + i), pct }));
  const { filter, report, state } = await setup({ launch: { bundle } });
  const res = await filter.run(report, state);
  assert.deepEqual(rules(res), ['bundled_launch']);
  assert.equal(res.metrics.bundle.pct, 12.5); // 2% dev + 3 x 3.5%; the migration's 24% is not counted
  assert.equal(res.metrics.bundle.buyers, 4);
  assert.equal(res.ttlMin, Infinity);
  assert.ok(state.bundles[report.mint], 'result is cached for the session');
});

test('kills when transfer-linked insider clusters hold more than 10%', async () => {
  const { filter, report, state, rpc } = await setup({ rug: { insiderNetworks: [{ id: 'a', size: 40, type: 'transfer', currentHolding: 0.08e15 }, { id: 'b', size: 30, type: 'transfer', currentHolding: 0.05e15 }] } });
  const res = await filter.run(report, state);
  assert.deepEqual(rules(res), ['bundled_launch']);
  assert.match(res.reasons[0].detail, /2 insider wallet clusters hold 13%/);
  assert.equal(rpc.calls.getSignatures, 0, 'launch trace is skipped once stage 2 has killed');
});

test('refuses anything that did not come from the Scout', async () => {
  const { filter, report, state } = await setup();
  await assert.rejects(filter.run({ ...report, stage: STAGE.FILTERED }, state), HandoffError);
});
