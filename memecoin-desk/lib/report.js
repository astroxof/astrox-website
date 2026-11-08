// Markdown session report (used by the Node runner and the browser "Report" button).
import { markEquity } from './agents/executor.js';
import { rulesSummary } from './desk.js';
import { round } from './util.js';

const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '–');
const sol = (x, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? '' : '−'}${Math.abs(x).toFixed(d)} SOL` : '–');
const pct = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%` : '–');
const dur = (ms) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

export function buildReport({ state, cfg, startedAt, endedAt = Date.now(), recentKills = [] }) {
  const pf = state.portfolio;
  const equity = markEquity(pf);
  const closed = pf.closed;
  const realized = closed.reduce((s, t) => s + t.pnlSol, 0);
  const open = Object.values(pf.positions);
  const unrealized = open.reduce((s, p) => s + p.tokens * p.lastPrice - p.sizeSol, 0);
  const wins = closed.filter((t) => t.pnlSol > 0);
  const losses = closed.filter((t) => t.pnlSol <= 0);
  const avg = (list, k) => (list.length ? list.reduce((s, t) => s + t[k], 0) / list.length : NaN);
  const st = state.stats;
  const kills = st.kills || {};
  const totalKills = Object.values(kills).reduce((a, b) => a + b, 0);
  const rules = rulesSummary(cfg);

  const lines = [];
  lines.push('# Memecoin desk: paper session report', '');
  lines.push(`Paper account since ${iso(state.createdAt)}. This session: ${iso(startedAt)} → ${iso(endedAt)} (${dur(endedAt - (startedAt || endedAt))}). Cycles run on this account: ${st.cycles}.`, '');
  lines.push('## Result', '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Starting bankroll | ${sol(pf.startingSol)} |`);
  lines.push(`| Equity now (open positions at last price) | ${sol(equity)} (${pct(((equity - pf.startingSol) / pf.startingSol) * 100, 2)}) |`);
  lines.push(`| Realized PnL | ${sol(realized, 4)} over ${closed.length} closed trade${closed.length === 1 ? '' : 's'} |`);
  lines.push(`| Unrealized PnL | ${sol(unrealized, 4)} on ${open.length} open position${open.length === 1 ? '' : 's'} |`);
  lines.push(`| Win rate | ${closed.length ? `${round((wins.length / closed.length) * 100, 0)}% (${wins.length}W / ${losses.length}L)` : '–'} |`);
  lines.push(`| Avg win / avg loss | ${pct(avg(wins, 'pnlPct'))} / ${pct(avg(losses, 'pnlPct'))} |`);
  lines.push('');

  lines.push('## Pipeline', '');
  lines.push(`- **Scout** handed ${st.candidates} in-window coin evaluations to the Filter (${rules.scout}).`);
  lines.push(`- **Filter** killed ${kills.filter || 0}, passed ${st.passes.filter} to the Analyst.`);
  lines.push(`- **Analyst** killed ${kills.analyst || 0}, passed ${st.passes.analyst} with score ≥ ${cfg.analyst.passScore}.`);
  lines.push(`- **Executor / Risk** opened ${st.entries} paper position${st.entries === 1 ? '' : 's'}; ${(kills.executor || 0) + (kills.risk || 0)} tickets refused (cash, cooldown, size).`);
  lines.push(`- **Logger** recorded ${totalKills} kills in total.`);
  lines.push('');

  const byRule = Object.entries(st.killsByRule || {}).sort((a, b) => b[1] - a[1]);
  if (byRule.length) {
    lines.push('## Kills by rule', '', '| Rule | Kills |', '|---|---:|');
    for (const [rule, n] of byRule) lines.push(`| ${rule.replaceAll('_', ' ')} | ${n} |`);
    lines.push('', 'A coin can trip several rules at once, so this sums to more than the kill count. Kills on dynamic rules (liquidity, volume, top 10, score...) are re-tested after a cooldown, so one coin can be killed more than once.', '');
  }

  if (closed.length) {
    lines.push('## Closed trades', '', '| Token | Opened | Size | PnL | Peak | Exit | Held |', '|---|---|---:|---:|---:|---|---:|');
    for (const t of closed.slice().reverse()) {
      lines.push(`| ${t.symbol} | ${iso(t.openedAt)} | ${sol(t.sizeSol)} | ${pct(t.pnlPct)} (${sol(t.pnlSol, 4)}) | ${pct(t.peakPct)} | ${t.exitReason} | ${dur(t.holdMin * 60_000)} |`);
    }
    lines.push('');
  }
  if (open.length) {
    lines.push('## Open positions', '', '| Token | Opened | Size | Now | Stop | Trail |', '|---|---|---:|---:|---:|---|');
    for (const p of open) {
      lines.push(`| ${p.symbol} | ${iso(p.openedAt)} | ${sol(p.sizeSol)} | ${pct(((p.lastPrice - p.entryPrice) / p.entryPrice) * 100)} | ${pct(((p.stopPrice - p.entryPrice) / p.entryPrice) * 100)} | ${p.trailActive ? 'on' : `at ${pct(cfg.risk.trailActivatePct, 0)}`} |`);
    }
    lines.push('');
  }

  const sample = recentKills.slice(0, 25);
  if (sample.length) {
    lines.push('## Latest kills', '', '| Time | Token | Agent | Why |', '|---|---|---|---|');
    for (const k of sample) lines.push(`| ${k.t.slice(11, 19)} | ${k.symbol} | ${k.agent} | ${k.reasons.map((r) => r.detail).join('; ').replaceAll('|', '/')} |`);
    lines.push('', 'Every kill is in the JSONL log and kills CSV.', '');
  }

  lines.push('## Rules in force', '');
  for (const [agent, text] of Object.entries(rules)) lines.push(`- **${agent[0].toUpperCase() + agent.slice(1)}**: ${text}`);
  lines.push('', `Paper fills include a ${cfg.paper.dexFeePct}% DEX fee and ${cfg.paper.slippagePct}% slippage per side, ${cfg.paper.networkFeeSol} SOL network fee per transaction, and constant-product price impact from pool depth. Stops are checked every ${cfg.loop.riskTickSeconds}s and fill at the observed price, so gaps through the stop are realised as losses.`);
  return lines.join('\n');
}
