export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const num = (x, fallback = 0) => {
  const n = typeof x === 'string' ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : fallback;
};

export const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

// Linear ramp: value at `lo` -> 0, value at `hi` -> 1, clamped.
export const ramp = (value, lo, hi) => clamp01((value - lo) / (hi - lo));

// Log ramp for count-like metrics (buyers, holders/hour).
export const logRamp = (value, lo, hi) => (value <= lo ? 0 : clamp01(Math.log(value / lo) / Math.log(hi / lo)));

export const round = (x, digits = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : x);

export const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

export function fmtUsd(x) {
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(2)}`;
}

export const fmtPct = (x, digits = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%` : '–');

export const fmtSol = (x, digits = 3) => (Number.isFinite(x) ? `${x.toFixed(digits)} SOL` : '–');

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

let seq = 0;
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
