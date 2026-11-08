// Agent 6 - Logger. Append-only record of every handoff, every kill, every fill and exit.
// Sinks are plain functions (console, JSONL file, CSV, in-memory ring for the UI).

export class Logger {
  constructor({ sinks = [] } = {}) {
    this.sinks = sinks;
  }

  addSink(fn) {
    this.sinks.push(fn);
  }

  emit(type, data = {}) {
    const event = { t: new Date().toISOString(), type, ...data };
    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch {
        // a broken sink must never stop the desk
      }
    }
    return event;
  }

  // Every kill, by any agent, goes through here.
  kill(agent, item, reasons, extra = {}) {
    return this.emit('kill', {
      agent,
      mint: item.mint,
      symbol: item.symbol,
      pair: item.pair?.address,
      reasons: reasons.map((r) => ({ rule: r.rule, detail: r.detail })),
      trail: (item.trail || []).map((h) => h.agent),
      ...extra,
    });
  }

  handoff(from, to, item, extra = {}) {
    return this.emit('handoff', { from, to, mint: item.mint, symbol: item.symbol, ...extra });
  }
}
