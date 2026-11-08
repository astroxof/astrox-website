// End-to-end: the real Desk wiring against a fake network (DexScreener, GeckoTerminal, RugCheck, RPC).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Desk } from '../lib/desk.js';
import { STAGE } from '../lib/handoff.js';
import { SUPPLY, addr, dexPair, launchHistory, rugReport } from './helpers.js';

const GOOD = addr(11);
const BAD = addr(12);
const POOL_GOOD = addr(21);
const POOL_BAD = addr(22);
const DEV = addr(31);

async function network() {
  const pairs = {
    [GOOD]: dexPair({ mint: GOOD, symbol: 'GOOD', pool: POOL_GOOD }),
    [BAD]: dexPair({ mint: BAD, symbol: 'BUNDLE', pool: POOL_BAD }),
  };
  const histories = {
    [GOOD]: await launchHistory({ mint: GOOD, creator: DEV, pool: POOL_GOOD }),
    [BAD]: await launchHistory({ mint: BAD, creator: DEV, pool: POOL_BAD, bundle: [{ owner: addr(41), pct: 30 }, { owner: addr(42), pct: 30 }] }),
  };
  const byCurve = Object.fromEntries(Object.values(histories).map((h) => [h.curve, h]));
  const txs = { ...histories[GOOD].txs };
  const net = { pairs, priceSol: { [POOL_GOOD]: 0.0000165 }, calls: [] };
  const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

  net.fetch = async (url, opts = {}) => {
    net.calls.push(url);
    if (opts.method === 'POST') {
      const { id, method, params } = JSON.parse(opts.body);
      let result;
      if (method === 'getAccountInfo') result = { value: { data: { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority: null, freezeAuthority: null, supply: String(SUPPLY), decimals: 6 } } } } };
      if (method === 'getSignaturesForAddress') result = byCurve[params[0]].sigs;
      if (method === 'getTransaction') {
        const owner = Object.values(histories).find((h) => h.sigs.some((s) => s.signature === params[0]) && h.txs === histories[BAD].txs && params[0] === 'bundle');
        result = owner ? histories[BAD].txs.bundle : txs[params[0]] ?? histories[BAD].txs[params[0]];
      }
      return json({ jsonrpc: '2.0', id, result });
    }
    const u = new URL(url);
    if (u.hostname === 'api.dexscreener.com') {
      if (u.pathname.startsWith('/token-profiles')) return json([{ chainId: 'solana', tokenAddress: GOOD }, { chainId: 'solana', tokenAddress: BAD }]);
      if (u.pathname.startsWith('/token-boosts') || u.pathname.startsWith('/community')) return json([]);
      if (u.pathname.startsWith('/tokens/v1/solana/')) return json(u.pathname.split('/').pop().split(',').map((m) => pairs[m]).filter(Boolean));
      if (u.pathname.startsWith('/latest/dex/pairs/solana/')) {
        const p = { ...pairs[GOOD], priceNative: String(net.priceSol[POOL_GOOD]) };
        return json({ pairs: [p] });
      }
    }
    if (u.hostname === 'api.geckoterminal.com') {
      if (u.pathname.includes('/pools/multi/')) return json({ data: [{ attributes: { address: POOL_GOOD, transactions: { h1: { buyers: 900, sellers: 400 }, m5: { buyers: 90 } } } }] });
      return json({ data: [] });
    }
    if (u.hostname === 'api.rugcheck.xyz') {
      const mint = u.pathname.split('/')[3];
      return json(rugReport({ mint, pool: mint === GOOD ? POOL_GOOD : POOL_BAD, creator: DEV }));
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
  };
  return net;
}

test('one cycle: bundled coin killed, clean coin bought with a stop; Risk then stops it out', async () => {
  const net = await network();
  const events = [];
  let saved = null;
  const desk = new Desk({
    config: { http: { hosts: {} }, rpc: { url: 'https://rpc.test', minIntervalMs: 0, txMinIntervalMs: 0 } },
    store: { load: async () => null, save: async (s) => (saved = s) },
    sinks: [(e) => events.push(e)],
    fetchImpl: net.fetch,
  });
  await desk.init();
  await desk.runCycle();

  const kills = events.filter((e) => e.type === 'kill');
  assert.equal(kills.length, 1);
  assert.equal(kills[0].symbol, 'BUNDLE');
  assert.equal(kills[0].agent, 'filter');
  assert.deepEqual(kills[0].reasons.map((r) => r.rule), ['bundled_launch']);
  assert.equal(kills[0].recheckIn, 'never');

  const chain = events.filter((e) => e.type === 'handoff' && e.symbol === 'GOOD').map((e) => `${e.from}>${e.to}`);
  assert.deepEqual(chain, ['scout>filter', 'filter>analyst', 'analyst>executor', 'executor>risk', 'risk>executor']);
  const entry = events.find((e) => e.type === 'entry');
  assert.equal(entry.symbol, 'GOOD');
  assert.equal(entry.sizeSol, 0.8);
  assert.ok(entry.stopPrice < entry.entryPrice);
  assert.ok(saved.portfolio.positions[GOOD], 'state persisted');

  // second cycle: the bundled coin is in permanent cooldown, the good one is held -> nothing re-evaluated
  await desk.runCycle();
  assert.equal(events.filter((e) => e.type === 'kill').length, 1);
  assert.equal(events.filter((e) => e.type === 'entry').length, 1);

  // price falls 9% -> Risk exits on the stop
  net.priceSol[POOL_GOOD] = 0.0000165 * 0.91;
  await desk.riskTick();
  const exit = events.find((e) => e.type === 'exit');
  assert.equal(exit.reason, 'stop loss');
  assert.ok(exit.pnlSol < 0);
  assert.deepEqual(desk.state.portfolio.positions, {});
  assert.equal(desk.snapshot().portfolio.trades, 1);
});

test('handoff stages are what each agent emits', () => {
  assert.deepEqual(Object.values(STAGE), ['scout:found', 'filter:passed', 'analyst:passed', 'executor:ticket', 'risk:armed']);
});
