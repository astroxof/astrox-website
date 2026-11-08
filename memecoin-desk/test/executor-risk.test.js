import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { HandoffError, STAGE, handoff } from '../lib/handoff.js';
import { Executor, PaperBroker } from '../lib/agents/executor.js';
import { Risk } from '../lib/agents/risk.js';
import { addr, dexPair, scoutReport } from './helpers.js';

const cfg = DEFAULT_CONFIG;
const broker = new PaperBroker(cfg.paper);
const executor = new Executor({ cfg, broker });
const risk = new Risk({ cfg });
const portfolio = (cash = 10) => ({ startingSol: 10, cashSol: cash, positions: {}, closed: [] });
const analyzed = () => handoff({ ...scoutReport(dexPair({ mint: addr(9), pool: addr(1) })), score: 80, components: {} }, 'analyst', STAGE.ANALYZED);
const quote = (priceSol, liquidityUsd = 120_000) => ({ priceSol, priceUsd: priceSol * 90, liquidityUsd, liquidityQuote: 660 });

async function open(pf = portfolio()) {
  const t = await executor.prepare(analyzed(), pf, { solUsd: 90 });
  const r = risk.arm(t.ticket, pf);
  return { pf, ticket: t.ticket, armed: r.ticket, pos: executor.fill(r.ticket, pf) };
}

test('Executor sizes at most 8% of equity and never more than cash', async () => {
  const t = await executor.prepare(analyzed(), portfolio(), { solUsd: 90 });
  assert.equal(t.ticket.stage, STAGE.TICKET);
  assert.equal(t.ticket.order.sizeSol, 0.8);
  // 9.5 SOL tied up in another position: equity is 10, but only 0.5 SOL cash is free
  const mostlyInvested = { ...portfolio(0.5), positions: { other: { tokens: 950_000, lastPrice: 1e-5, entryPrice: 1e-5 } } };
  assert.equal((await executor.prepare(analyzed(), mostlyInvested, { solUsd: 90 })).ticket.order.sizeSol, 0.5);
  assert.equal((await executor.prepare(analyzed(), portfolio(0.01), { solUsd: 90 })).reasons[0].rule, 'insufficient_cash');
});

test('a ticket cannot be filled unless Risk armed a stop first', async () => {
  const pf = portfolio();
  const t = await executor.prepare(analyzed(), pf, { solUsd: 90 });
  assert.throws(() => executor.fill(t.ticket, pf), HandoffError);
  assert.throws(() => executor.fill({ ...t.ticket, stage: STAGE.ARMED, risk: {} }, pf), HandoffError);
  assert.equal(pf.cashSol, 10, 'no cash moved');
});

test('Risk arms the stop 6% under entry and the trail trigger at +12%', async () => {
  const { armed, pos, pf } = await open();
  const entry = armed.order.expectedPrice;
  assert.ok(Math.abs(armed.risk.stopPrice / entry - 0.94) < 1e-12);
  assert.ok(Math.abs(armed.risk.trailActivatePrice / entry - 1.12) < 1e-12);
  assert.ok(armed.risk.armedAt <= pos.openedAt, 'stop exists before the fill');
  assert.deepEqual(pos.trail, ['scout', 'analyst', 'executor', 'risk', 'executor']);
  assert.ok(Math.abs(pf.cashSol - 9.2) < 1e-9);
});

test('stop loss exits at the observed price, including a gap through the stop', async () => {
  const { pos, pf } = await open();
  assert.equal(risk.evaluate(pos, quote(pos.entryPrice * 0.97)).exit, false);
  const d = risk.evaluate(pos, quote(pos.entryPrice * 0.9));
  assert.equal(d.exit, true);
  assert.equal(d.reason, 'stop loss');
  const trade = executor.close(pos, quote(pos.entryPrice * 0.9), d.reason, pf, 90);
  assert.ok(trade.pnlPct < -10 && trade.pnlPct > -14, `gap fill realises the full drop plus costs (${trade.pnlPct})`);
  assert.deepEqual(pf.positions, {});
});

test('trailing stop switches on at +12% and locks in profit on the way down', async () => {
  const { pos, pf } = await open();
  const e = pos.entryPrice;
  assert.deepEqual(risk.evaluate(pos, quote(e * 1.1)).events, []);
  const on = risk.evaluate(pos, quote(e * 1.2));
  assert.ok(on.events.includes('trail_on'));
  assert.ok(Math.abs(pos.stopPrice / e - 1.2 * 0.94) < 1e-9);
  risk.evaluate(pos, quote(e * 1.3)); // new peak raises the stop
  const out = risk.evaluate(pos, quote(e * 1.2));
  assert.equal(out.exit, true);
  assert.equal(out.reason, 'trailing stop');
  assert.ok(executor.close(pos, quote(e * 1.2), out.reason, pf, 90).pnlSol > 0);
});

test('emergency exit when the pool is drained', async () => {
  const { pos } = await open();
  const d = risk.evaluate(pos, quote(pos.entryPrice, 20_000));
  assert.equal(d.exit, true);
  assert.match(d.reason, /liquidity pulled/);
});

test('paper fills cost fees, slippage and price impact on both sides', () => {
  const pool = { liquidityQuote: 660, liquidityUsd: 120_000, solUsd: 90 };
  const buy = broker.quoteBuy({ sizeSol: 0.8, priceSol: 1e-5, pool });
  const sell = broker.quoteSell({ tokens: buy.tokens, priceSol: 1e-5, pool });
  const roundTrip = (sell.proceedsSol / 0.8 - 1) * 100;
  assert.ok(roundTrip < -2.5 && roundTrip > -4.5, `flat round trip costs ~3-4% (${roundTrip.toFixed(2)}%)`);
});
