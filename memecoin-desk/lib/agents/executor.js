// Agent 4 - Executor. Sizes the trade (max 8% of equity), hands the ticket to Risk, and only fills
// a ticket that comes back from Risk with a stop already armed. Paper fills only.
import { HandoffError, STAGE, expectStage, handoff } from '../handoff.js';
import { newId, num, round } from '../util.js';
import { pairView } from './scout.js';

export class PaperBroker {
  constructor({ dexFeePct = 1, slippagePct = 0.5, networkFeeSol = 0.002 } = {}) {
    this.dexFeePct = dexFeePct;
    this.slippagePct = slippagePct;
    this.networkFeeSol = networkFeeSol;
  }

  // SOL side of the pool; constant-product price impact ~= trade size / that reserve.
  static quoteReserveSol({ liquidityQuote, liquidityUsd, solUsd }) {
    if (liquidityQuote > 0) return liquidityQuote;
    return solUsd > 0 ? liquidityUsd / 2 / solUsd : 0;
  }

  quoteBuy({ sizeSol, priceSol, pool }) {
    const reserve = PaperBroker.quoteReserveSol(pool);
    const afterNetwork = sizeSol - this.networkFeeSol;
    const dexFee = (afterNetwork * this.dexFeePct) / 100;
    const spend = afterNetwork - dexFee;
    const impact = reserve > 0 ? spend / reserve : 1;
    const avgPrice = priceSol * (1 + impact) * (1 + this.slippagePct / 100);
    return { tokens: spend / avgPrice, avgPrice, impactPct: impact * 100, feesSol: this.networkFeeSol + dexFee };
  }

  quoteSell({ tokens, priceSol, pool }) {
    const reserve = PaperBroker.quoteReserveSol(pool);
    const gross = tokens * priceSol;
    const factor = reserve > 0 ? 1 / (1 + gross / reserve) : 0;
    const avgPrice = priceSol * factor * (1 - this.slippagePct / 100);
    const beforeFee = tokens * avgPrice;
    const dexFee = (beforeFee * this.dexFeePct) / 100;
    return { proceedsSol: Math.max(0, beforeFee - dexFee - this.networkFeeSol), avgPrice, impactPct: (1 - factor) * 100, feesSol: dexFee + this.networkFeeSol };
  }
}

export function markEquity(portfolio) {
  let held = 0;
  for (const pos of Object.values(portfolio.positions)) held += pos.tokens * num(pos.lastPrice, pos.entryPrice);
  return portfolio.cashSol + held;
}

export class Executor {
  constructor({ cfg, broker, dex = null }) {
    this.cfg = cfg;
    this.broker = broker;
    this.dex = dex;
  }

  // The Scout's quote is up to a minute old by now; price the ticket off a fresh one.
  async requote(candidate) {
    if (!this.dex) return candidate;
    try {
      const [p] = await this.dex.pairs([candidate.pair.address]);
      if (p && num(p.priceNative) > 0) return { ...candidate, pair: { ...candidate.pair, ...pairView(p) }, requotedAt: Date.now() };
    } catch {
      // keep the scan quote
    }
    return candidate;
  }

  async prepare(analyzed, portfolio, { solUsd, lastExit = {} }) {
    expectStage('executor', analyzed, STAGE.ANALYZED);
    const e = this.cfg.executor;
    const now = Date.now();
    const kill = (rule, detail) => ({ verdict: 'kill', reasons: [{ rule, detail, retry: true }] });

    if (portfolio.positions[analyzed.mint]) return kill('already_holding', 'position already open');
    const exitedAt = lastExit[analyzed.mint];
    if (exitedAt && now - exitedAt < e.reentryCooldownMinutes * 60_000) return kill('reentry_cooldown', `exited ${round((now - exitedAt) / 60_000, 0)}m ago (cooldown ${e.reentryCooldownMinutes}m)`);
    const open = Object.keys(portfolio.positions).length;
    if (e.maxOpenPositions > 0 && open >= e.maxOpenPositions) return kill('max_positions', `${open} positions open (max ${e.maxOpenPositions})`);

    const equity = markEquity(portfolio);
    const sizeSol = Math.min((equity * e.maxPositionPct) / 100, portfolio.cashSol);
    if (sizeSol < e.minTradeSol) return kill('insufficient_cash', `${round(portfolio.cashSol, 3)} SOL cash; min trade ${e.minTradeSol} SOL`);

    const candidate = await this.requote(analyzed);
    const p = candidate.pair;
    const pool = { liquidityQuote: p.liquidityQuote, liquidityUsd: p.liquidityUsd, solUsd };
    const q = this.broker.quoteBuy({ sizeSol, priceSol: p.priceSol, pool });
    if (!(q.tokens > 0) || !Number.isFinite(q.avgPrice)) return kill('no_quote', 'could not price the fill');

    const order = {
      side: 'buy',
      sizeSol,
      sizePctOfEquity: (sizeSol / equity) * 100,
      equitySol: equity,
      marketPrice: p.priceSol,
      expectedPrice: q.avgPrice,
      expectedTokens: q.tokens,
      impactPct: q.impactPct,
      feesSol: q.feesSol,
      pool,
    };
    return { verdict: 'ticket', ticket: handoff({ ...candidate, order }, 'executor', STAGE.TICKET) };
  }

  // Only a Risk-armed ticket can be filled.
  fill(armed, portfolio) {
    expectStage('executor', armed, STAGE.ARMED);
    const r = armed.risk;
    if (!(r?.stopPrice > 0) || !(r.stopPrice < armed.order.expectedPrice)) throw new HandoffError('executor', 'an armed stop below entry', 'no stop');
    const o = armed.order;
    portfolio.cashSol -= o.sizeSol;
    const position = {
      id: newId('pos'),
      mint: armed.mint,
      symbol: armed.symbol,
      name: armed.name,
      pairAddress: armed.pair.address,
      pairUrl: armed.pair.url,
      dexId: armed.pair.dexId,
      openedAt: Date.now(),
      sizeSol: o.sizeSol,
      tokens: o.expectedTokens,
      entryPrice: o.expectedPrice,
      entryPriceUsd: armed.pair.priceUsd,
      entryFeesSol: o.feesSol,
      impactPct: o.impactPct,
      stopPrice: r.stopPrice,
      initialStopPrice: r.stopPrice,
      trailActivatePrice: r.trailActivatePrice,
      trailDistancePct: r.trailDistancePct,
      trailActive: false,
      peakPrice: o.expectedPrice,
      lastPrice: armed.pair.priceSol,
      lastPriceUsd: armed.pair.priceUsd,
      lastQuoteAt: Date.now(),
      entryLiquidityUsd: armed.pair.liquidityUsd,
      lastLiquidityUsd: armed.pair.liquidityUsd,
      score: armed.score,
      components: Object.fromEntries(Object.entries(armed.components || {}).map(([k, v]) => [k, v.score])),
      trail: [...armed.trail.map((h) => h.agent), 'executor'],
    };
    portfolio.positions[armed.mint] = position;
    return position;
  }

  close(position, quote, reason, portfolio, solUsd) {
    const pool = { liquidityQuote: quote.liquidityQuote, liquidityUsd: quote.liquidityUsd, solUsd };
    const s = this.broker.quoteSell({ tokens: position.tokens, priceSol: quote.priceSol, pool });
    portfolio.cashSol += s.proceedsSol;
    delete portfolio.positions[position.mint];
    const trade = {
      ...position,
      closedAt: Date.now(),
      exitReason: reason,
      exitMarketPrice: quote.priceSol,
      exitPrice: s.avgPrice,
      exitImpactPct: s.impactPct,
      exitFeesSol: s.feesSol,
      proceedsSol: s.proceedsSol,
      pnlSol: s.proceedsSol - position.sizeSol,
      pnlPct: ((s.proceedsSol - position.sizeSol) / position.sizeSol) * 100,
      peakPct: ((position.peakPrice - position.entryPrice) / position.entryPrice) * 100,
      holdMin: (Date.now() - position.openedAt) / 60_000,
    };
    portfolio.closed.push(trade);
    return trade;
  }
}
