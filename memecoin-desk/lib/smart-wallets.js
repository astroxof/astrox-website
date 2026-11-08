// Tracks what your smart-money wallets currently hold, straight from on-chain token accounts.
import { isAddress } from './solana.js';
import { shortAddr } from './util.js';

export function normalizeWallets(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const address = typeof item === 'string' ? item.trim() : item?.address?.trim();
    if (!address || seen.has(address) || !isAddress(address)) continue;
    seen.add(address);
    out.push({ address, label: (typeof item === 'object' && item.label) || shortAddr(address) });
  }
  return out;
}

export class SmartWallets {
  constructor({ rpc, cfg }) {
    this.rpc = rpc;
    this.wallets = normalizeWallets(cfg.smartWallets.wallets);
    this.refreshMs = cfg.smartWallets.refreshMinutes * 60_000;
    this.holdings = new Map(); // address -> Map(mint -> amount)
    this.lastRefresh = 0;
  }

  get enabled() {
    return this.wallets.length > 0;
  }

  async refreshIfDue(force = false) {
    if (!this.enabled || (!force && Date.now() - this.lastRefresh < this.refreshMs)) return null;
    this.lastRefresh = Date.now();
    let ok = 0;
    const errors = [];
    for (const w of this.wallets) {
      try {
        this.holdings.set(w.address, await this.rpc.getTokenBalances(w.address));
        ok++;
      } catch (err) {
        errors.push(`${w.label}: ${err.message}`);
      }
    }
    return { wallets: this.wallets.length, refreshed: ok, errors };
  }

  holdersOf(mint) {
    return this.wallets.filter((w) => this.holdings.get(w.address)?.has(mint)).map((w) => w.label);
  }
}
