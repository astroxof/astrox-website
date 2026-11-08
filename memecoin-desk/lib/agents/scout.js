// Agent 1 - Scout. Finds Solana pairs 30m-72h old with $300k-$20M market cap (DexScreener data).
import { SOL_MINT } from '../config.js';
import { STAGE, handoff } from '../handoff.js';
import { median, newId, num } from '../util.js';

export class Scout {
  constructor({ cfg, dex, gecko }) {
    this.cfg = cfg;
    this.dex = dex;
    this.gecko = gecko;
  }

  geckoFeedsFor(cycle) {
    const feeds = this.cfg.scout.geckoFeeds;
    const n = Math.min(this.cfg.scout.geckoFeedsPerCycle, feeds.length);
    return Array.from({ length: n }, (_, i) => feeds[(cycle * n + i) % feeds.length]);
  }

  async run(state) {
    const s = this.cfg.scout;
    const now = Date.now();
    const sources = new Map();
    const add = (mint, source) => {
      if (!sources.has(mint)) sources.set(mint, new Set());
      sources.get(mint).add(source);
    };

    const dexFeeds = await this.dex.feeds();
    const gtFeeds = await this.gecko.discover(this.geckoFeedsFor(state.cycle), { maxAgeHours: s.maxAgeHours });
    for (const f of [...dexFeeds.found, ...gtFeeds.found]) add(f.mint, f.source);
    for (const mint of Object.keys(state.watch)) add(mint, 'watchlist');
    const errors = [...dexFeeds.errors, ...gtFeeds.errors];

    const stats = { discovered: sources.size, hydrated: 0, noSolPair: 0, tooYoung: 0, tooOld: 0, mcapLow: 0, mcapHigh: 0, inWindow: 0 };
    let pairs = [];
    try {
      pairs = await this.dex.tokens([...sources.keys()]);
    } catch (err) {
      errors.push(`hydrate: ${err.message}`);
    }

    const byMint = new Map();
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (p.chainId !== 'solana' || !sources.has(mint)) continue;
      if (!byMint.has(mint)) byMint.set(mint, []);
      byMint.get(mint).push(p);
    }
    stats.hydrated = byMint.size;

    const solUsd = median(pairs.filter((p) => p.quoteToken?.address === SOL_MINT).map((p) => num(p.priceUsd, NaN) / num(p.priceNative, NaN)));
    const reports = [];

    for (const [mint, list] of byMint) {
      const solPairs = list.filter((p) => p.quoteToken?.address === SOL_MINT && num(p.priceNative) > 0);
      if (!solPairs.length) {
        stats.noSolPair++;
        continue;
      }
      const main = solPairs.reduce((a, b) => (num(b.liquidity?.usd) > num(a.liquidity?.usd) ? b : a));
      const created = list.map((p) => p.pairCreatedAt).filter(Number.isFinite);
      const coinCreatedAt = created.length ? Math.min(...created) : NaN;
      const oldest = list.find((p) => p.pairCreatedAt === coinCreatedAt) || main;
      const ageMin = (now - coinCreatedAt) / 60_000;
      const mcapUsd = num(main.marketCap, num(main.fdv, NaN));

      if (!Number.isFinite(ageMin) || ageMin > s.maxAgeHours * 60) {
        stats.tooOld++;
        delete state.watch[mint];
        continue;
      }
      if (ageMin < s.minAgeMinutes) {
        stats.tooYoung++;
        continue;
      }
      if (!(mcapUsd >= s.minMcapUsd)) {
        stats.mcapLow++;
        continue;
      }
      if (mcapUsd > s.maxMcapUsd) {
        stats.mcapHigh++;
        continue;
      }
      stats.inWindow++;
      state.watch[mint] = { symbol: main.baseToken.symbol, lastSeen: now };

      reports.push(
        handoff(
          {
            id: newId('cand'),
            mint,
            symbol: main.baseToken.symbol,
            name: main.baseToken.name,
            sources: [...sources.get(mint)],
            ageMin,
            coinCreatedAt,
            mcapUsd,
            pair: pairView(main),
            oldestPair: { address: oldest.pairAddress, dexId: oldest.dexId, createdAt: oldest.pairCreatedAt },
            pairAddresses: list.map((p) => p.pairAddress),
            dexIds: [...new Set(list.map((p) => p.dexId))],
          },
          'scout',
          STAGE.SCOUTED,
        ),
      );
    }

    // keep the watchlist bounded: drop the least recently seen
    const watch = Object.entries(state.watch);
    if (watch.length > this.cfg.loop.watchlistMax) {
      watch.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [mint] of watch.slice(0, watch.length - this.cfg.loop.watchlistMax)) delete state.watch[mint];
    }

    // strongest first: the Analyst and Executor see the most active coins before cash runs out
    reports.sort((a, b) => num(b.pair.volume.h1) - num(a.pair.volume.h1));
    return { reports, stats, errors, solUsd };
  }
}

export function pairView(p) {
  return {
    address: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    priceUsd: num(p.priceUsd, NaN),
    priceSol: num(p.priceNative, NaN),
    liquidityUsd: num(p.liquidity?.usd),
    liquidityQuote: num(p.liquidity?.quote), // SOL side of the pool
    volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
    txns: {
      m5: { buys: num(p.txns?.m5?.buys), sells: num(p.txns?.m5?.sells) },
      h1: { buys: num(p.txns?.h1?.buys), sells: num(p.txns?.h1?.sells) },
    },
    priceChange: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    createdAt: p.pairCreatedAt,
  };
}
