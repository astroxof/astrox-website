// Every rule from the desk brief lives here, so the agents never hard-code a number.
// Override any value in config.local.json (Node) or the Settings panel (browser).

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const DEFAULT_CONFIG = {
  mode: 'paper', // Paper first. There is no live broker in this build.

  paper: {
    startingSol: 10, // paper bankroll
    dexFeePct: 1.0, // per side; conservative for PumpSwap/Raydium/Meteora fee tiers
    slippagePct: 0.5, // extra adverse fill per side (latency, MEV)
    networkFeeSol: 0.002, // priority fee + tip per transaction
  },

  loop: {
    cycleSeconds: 60, // Scout -> Filter -> Analyst -> Executor -> Risk -> Logger
    riskTickSeconds: 15, // how often Risk re-prices open positions
    watchlistMax: 150, // in-window coins re-checked even after they drop off the feeds
  },

  scout: {
    minAgeMinutes: 30,
    maxAgeHours: 72,
    minMcapUsd: 300_000,
    maxMcapUsd: 20_000_000,
    // GeckoTerminal endpoints rotated through (3 per cycle) to stay under its free rate limit.
    geckoFeeds: [
      'trending_pools?duration=5m',
      'trending_pools?duration=1h',
      'trending_pools?duration=6h',
      'pools?sort=h24_tx_count_desc',
      'pools?sort=h24_volume_usd_desc',
      'trending_pools?duration=5m&page=2',
      'trending_pools?duration=1h&page=2',
      'pools?sort=h24_tx_count_desc&page=2',
      'pools?sort=h24_volume_usd_desc&page=2',
    ],
    geckoFeedsPerCycle: 3,
  },

  filter: {
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    killDangerousToken2022: true, // permanent delegate, transfer hook, transfer fee, frozen-by-default, non-transferable
    minLpLockedPct: 90, // main pool LP burned or locked
    minLiquidityUsd: 40_000,
    minVolume1hUsd: 50_000,
    maxTop10Pct: 25, // excludes pool/locker accounts
    maxDevPct: 3,
    killDevPastRugs: true,
    maxBundledPct: 10,
    maxPriceChange1hPct: 80, // already +80% in 1h = too late
    bundle: {
      slotWindow: 0, // 0 = only buys landing in the creation slot count as the launch bundle
      maxSignaturePages: 10, // x1000 signatures of curve history to reach the creation slot
      maxLaunchTxs: 40,
      includeInsiderClusters: true, // also count RugCheck transfer-linked wallet clusters (dispersed bundles)
      killIfUnverifiable: true, // fail closed when the launch slot cannot be reached
    },
    recheckMinutes: 15, // dynamic kills (liq, vol, top 10...) are re-tested after this
    unverifiableRetryMinutes: 5,
  },

  analyst: {
    passScore: 70,
    // Equal weights by default; components without data (e.g. no smart-wallet list) are dropped and the rest re-normalised.
    weights: { momentum: 1, uniqueBuyers: 1, buySellRatio: 1, holderGrowth: 1, liqToMcap: 1, smartWallets: 1 },
    minComponents: 4,
  },

  executor: {
    maxPositionPct: 8, // of current equity, per trade
    minTradeSol: 0.05,
    maxOpenPositions: 0, // 0 = no cap beyond cash
    reentryCooldownMinutes: 120,
  },

  risk: {
    stopLossPct: 6, // armed before entry
    trailActivatePct: 12, // trailing stop switches on at +12%
    trailDistancePct: 6, // then follows the peak at this distance
    liquidityPullExitPct: 60, // emergency exit if pool liquidity falls this much below entry
    staleQuoteMinutes: 10,
  },

  smartWallets: {
    wallets: [], // [{ address, label }] wallets you consider smart money
    refreshMinutes: 5,
  },

  rpc: {
    url: 'https://api.mainnet-beta.solana.com', // use your own (e.g. Helius free tier) for overnight runs
    minIntervalMs: 150,
    txMinIntervalMs: 1100, // public RPC throttles getTransaction hard
  },

  http: {
    timeoutMs: 15_000,
    hosts: {
      'api.dexscreener.com': 250,
      'api.geckoterminal.com': 2600,
      'api.rugcheck.xyz': 700,
    },
  },
};

export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v);
    } else if (v !== undefined) {
      out[k] = structuredClone(v);
    }
  }
  return out;
}
