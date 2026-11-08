import { SOL_MINT, USDC_MINT, USDT_MINT } from './config.js';
import { chunk } from './util.js';

const QUOTES = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export class DexScreener {
  constructor(http) {
    this.http = http;
    this.base = 'https://api.dexscreener.com';
  }

  // Tokens DexScreener is surfacing right now (profiles, boosts, community takeovers). Solana only.
  async feeds() {
    const paths = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1', '/community-takeovers/latest/v1'];
    const found = [];
    const errors = [];
    for (const path of paths) {
      try {
        const list = await this.http.json(this.base + path);
        for (const item of Array.isArray(list) ? list : []) {
          if (item.chainId === 'solana' && item.tokenAddress) found.push({ mint: item.tokenAddress, source: `dex${path.split('/')[1].replace('token-', '').replace('community-', '')}` });
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { found, errors };
  }

  // All pairs for up to N tokens (30 per request).
  async tokens(mints) {
    const pairs = [];
    for (const group of chunk([...new Set(mints)], 30)) {
      const res = await this.http.json(`${this.base}/tokens/v1/solana/${group.join(',')}`);
      if (Array.isArray(res)) pairs.push(...res);
    }
    return pairs;
  }

  // Fresh quotes for specific pairs (30 per request).
  async pairs(pairAddresses) {
    const out = [];
    for (const group of chunk([...new Set(pairAddresses)], 30)) {
      const res = await this.http.json(`${this.base}/latest/dex/pairs/solana/${group.join(',')}`);
      out.push(...(res?.pairs || (res?.pair ? [res.pair] : [])));
    }
    return out;
  }
}

export class GeckoTerminal {
  constructor(http) {
    this.http = http;
    this.base = 'https://api.geckoterminal.com/api/v2/networks/solana';
  }

  async discover(feedPaths, { maxAgeHours = 72 } = {}) {
    const found = [];
    const errors = [];
    const now = Date.now();
    for (const path of feedPaths) {
      try {
        const res = await this.http.json(`${this.base}/${path}`);
        for (const pool of res?.data || []) {
          const base = pool.relationships?.base_token?.data?.id?.replace('solana_', '');
          const quote = pool.relationships?.quote_token?.data?.id?.replace('solana_', '');
          const mint = QUOTES.has(base) ? quote : base;
          if (!mint || QUOTES.has(mint)) continue;
          const created = Date.parse(pool.attributes?.pool_created_at);
          if (Number.isFinite(created) && now - created > maxAgeHours * 3_600_000) continue; // coin is at least as old as this pool
          found.push({ mint, source: `gt:${path.split('?')[1]?.replace(/^(duration|sort)=/, '').replace('&page=', ' p') || path}` });
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { found, errors };
  }

  // pool address -> attributes (includes unique buyers/sellers per window).
  async pools(addresses) {
    const out = new Map();
    for (const group of chunk([...new Set(addresses)], 30)) {
      const res = await this.http.json(`${this.base}/pools/multi/${group.join(',')}`);
      for (const pool of res?.data || []) out.set(pool.attributes?.address, pool.attributes);
    }
    return out;
  }
}

export class RugCheck {
  constructor(http) {
    this.http = http;
    this.base = 'https://api.rugcheck.xyz/v1';
  }

  report(mint) {
    return this.http.json(`${this.base}/tokens/${mint}/report`);
  }
}

export const isQuoteMint = (mint) => QUOTES.has(mint);
