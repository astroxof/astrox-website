// Agent 5 - Risk. Arms the -6% stop on every ticket BEFORE entry, then manages open positions:
// trailing stop switches on at +12% and follows the peak; emergency exit if the pool is drained.
import { STAGE, expectStage, handoff } from '../handoff.js';
import { markEquity } from './executor.js';
import { round } from '../util.js';

export class Risk {
  constructor({ cfg }) {
    this.cfg = cfg;
  }

  arm(ticket, portfolio) {
    expectStage('risk', ticket, STAGE.TICKET);
    const r = this.cfg.risk;
    const o = ticket.order;
    const equity = markEquity(portfolio);
    const maxSize = (equity * this.cfg.executor.maxPositionPct) / 100;
    if (o.sizeSol > maxSize * 1.0001) return { verdict: 'kill', reasons: [{ rule: 'size_limit', detail: `${round(o.sizeSol, 3)} SOL > ${this.cfg.executor.maxPositionPct}% of equity (${round(maxSize, 3)} SOL)`, retry: true }] };
    if (o.sizeSol > portfolio.cashSol + 1e-9) return { verdict: 'kill', reasons: [{ rule: 'insufficient_cash', detail: 'ticket larger than cash', retry: true }] };
    if (!(o.expectedPrice > 0)) return { verdict: 'kill', reasons: [{ rule: 'no_price', detail: 'no entry price to place a stop against', retry: true }] };

    const risk = {
      stopPrice: o.expectedPrice * (1 - r.stopLossPct / 100),
      stopLossPct: r.stopLossPct,
      trailActivatePrice: o.expectedPrice * (1 + r.trailActivatePct / 100),
      trailActivatePct: r.trailActivatePct,
      trailDistancePct: r.trailDistancePct,
      armedAt: Date.now(),
    };
    return { verdict: 'armed', ticket: handoff({ ...ticket, risk }, 'risk', STAGE.ARMED) };
  }

  // Called every risk tick with a fresh quote. Mutates the position; returns what happened.
  evaluate(position, quote) {
    const r = this.cfg.risk;
    const events = [];
    const price = quote.priceSol;
    position.lastPrice = price;
    position.lastPriceUsd = quote.priceUsd;
    position.lastLiquidityUsd = quote.liquidityUsd;
    position.lastQuoteAt = Date.now();
    position.staleWarned = false;
    if (price > position.peakPrice) position.peakPrice = price;

    if (!position.trailActive && position.peakPrice >= position.trailActivatePrice) {
      position.trailActive = true;
      events.push('trail_on');
    }
    if (position.trailActive) {
      const trailStop = position.peakPrice * (1 - position.trailDistancePct / 100);
      if (trailStop > position.stopPrice) {
        position.stopPrice = trailStop;
        events.push('trail_raised');
      }
    }

    const pulled = position.entryLiquidityUsd > 0 && quote.liquidityUsd < position.entryLiquidityUsd * (1 - r.liquidityPullExitPct / 100);
    if (pulled) return { exit: true, reason: `liquidity pulled (${round(quote.liquidityUsd, 0)} < ${100 - r.liquidityPullExitPct}% of entry)`, events };
    if (price <= position.stopPrice) return { exit: true, reason: position.trailActive ? 'trailing stop' : 'stop loss', events };
    return { exit: false, events };
  }
}
