// Fixture builders shaped like the real DexScreener / GeckoTerminal / RugCheck / RPC responses.
import { SOL_MINT } from '../lib/config.js';
import { STAGE, handoff } from '../lib/handoff.js';
import { base58Encode, pumpBondingCurve } from '../lib/solana.js';

export const addr = (n) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256));
export const SUPPLY = 1_000_000_000_000_000; // 1B tokens, 6 decimals

export function dexPair({ mint, symbol = 'TEST', pool, priceSol = 0.0000165, priceUsd = 0.0015, liqUsd = 120_000, liqQuote = 660, vol = {}, pc = {}, txns = {}, mcap = 1_500_000, ageMin = 300, dexId = 'pumpswap', quote = SOL_MINT }) {
  return {
    chainId: 'solana',
    dexId,
    url: `https://dexscreener.com/solana/${pool}`,
    pairAddress: pool,
    baseToken: { address: mint, name: symbol, symbol },
    quoteToken: { address: quote, name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: String(priceSol),
    priceUsd: String(priceUsd),
    txns: { m5: { buys: 200, sells: 120 }, h1: { buys: 2000, sells: 1300 }, ...txns },
    volume: { m5: 15_000, h1: 150_000, h6: 500_000, h24: 900_000, ...vol },
    priceChange: { m5: 4, h1: 25, h6: 40, h24: 60, ...pc },
    liquidity: { usd: liqUsd, base: 1, quote: liqQuote },
    fdv: mcap,
    marketCap: mcap,
    pairCreatedAt: Date.now() - ageMin * 60_000,
  };
}

export function scoutReport(pair, extra = {}) {
  const ageMin = (Date.now() - pair.pairCreatedAt) / 60_000;
  return handoff(
    {
      id: 'cand-test',
      mint: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      sources: ['test'],
      ageMin,
      coinCreatedAt: pair.pairCreatedAt,
      mcapUsd: pair.marketCap,
      pair: {
        address: pair.pairAddress,
        dexId: pair.dexId,
        url: pair.url,
        priceUsd: +pair.priceUsd,
        priceSol: +pair.priceNative,
        liquidityUsd: pair.liquidity.usd,
        liquidityQuote: pair.liquidity.quote,
        volume: pair.volume,
        txns: pair.txns,
        priceChange: pair.priceChange,
        createdAt: pair.pairCreatedAt,
      },
      oldestPair: { address: pair.pairAddress, dexId: pair.dexId, createdAt: pair.pairCreatedAt },
      pairAddresses: [pair.pairAddress],
      dexIds: [pair.dexId],
      ...extra,
    },
    'scout',
    STAGE.SCOUTED,
  );
}

export function rugReport({ mint, pool, creator, creatorBalance = 0, lpLockedPct = 100, holders = [], risks = [], insiderNetworks = [], totalHolders = 4000, mintAuthority = null, freezeAuthority = null }) {
  const vaultA = addr(901);
  const topHolders = [
    { address: vaultA, owner: pool, pct: 12, insider: false }, // pool vault: must be ignored by the top-10 rule
    ...(holders.length ? holders : Array.from({ length: 12 }, (_, i) => ({ address: addr(500 + i), owner: addr(600 + i), pct: 1.5, insider: false }))),
  ];
  return {
    mint,
    creator,
    creatorBalance,
    token: { mintAuthority, freezeAuthority, supply: SUPPLY, decimals: 6 },
    markets: [{ pubkey: pool, marketType: 'pump_fun_amm', liquidityA: vaultA, liquidityB: addr(902), lp: { lpLockedPct, baseUSD: 60_000, quoteUSD: 60_000 } }],
    topHolders,
    risks,
    insiderNetworks,
    graphInsidersDetected: insiderNetworks.reduce((s, n) => s + n.size, 0),
    totalHolders,
    knownAccounts: {},
    launchpad: { platform: 'pump_fun' },
    rugged: false,
  };
}

// A launch: create tx (dev buy) in slot 100, optional bundle tx in the same slot, a migration, then later organic buys.
export async function launchHistory({ mint, creator, pool, devBuyPct = 2, bundle = [], sameSlotMigration = true }) {
  const curve = await pumpBondingCurve(mint);
  const raw = (pct) => String(Math.round((pct / 100) * SUPPLY));
  const tx = (signer, credits, logs = []) => ({
    meta: {
      err: null,
      logMessages: logs,
      preTokenBalances: [],
      postTokenBalances: credits.map((c, i) => ({ accountIndex: i + 1, mint, owner: c.owner, uiTokenAmount: { amount: raw(c.pct) } })),
    },
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, ...credits.map((c, i) => ({ pubkey: addr(700 + i), signer: false }))] } },
  });
  const txs = {
    create: tx(creator, [{ owner: curve, pct: 98 }, { owner: creator, pct: devBuyPct }], ['Program log: Instruction: CreateV2', 'Program log: Instruction: BuyV2']),
    later: tx(addr(801), [{ owner: addr(801), pct: 0.5 }], ['Program log: Instruction: BuyV2']),
  };
  // Newest first, like getSignaturesForAddress.
  const sigs = [{ signature: 'later', slot: 105, err: null }];
  if (sameSlotMigration) {
    txs.migrate = tx(creator, [{ owner: pool, pct: 20 }, { owner: addr(803), pct: 4 }], ['Program log: Instruction: MigrateV2']);
    sigs.push({ signature: 'migrate', slot: 100, err: null });
  }
  if (bundle.length) {
    txs.bundle = tx(bundle[0].owner, bundle, ['Program log: Instruction: BuyV2']);
    sigs.push({ signature: 'bundle', slot: 100, err: null });
  }
  sigs.push({ signature: 'create', slot: 100, err: null });
  // A sniper's failed tx that landed before creation must not move the launch slot.
  sigs.push({ signature: 'failed-snipe', slot: 99, err: { InstructionError: [0, 'Custom'] } });
  return { curve, txs, sigs };
}

export function fakeRpc({ mintInfo = {}, history, balances = new Map() } = {}) {
  const calls = { getMint: 0, getSignatures: 0, getTransaction: 0 };
  return {
    calls,
    async getMint() {
      calls.getMint++;
      return { program: 'spl-token-2022', mintAuthority: null, freezeAuthority: null, supply: String(SUPPLY), decimals: 6, extensions: [], ...mintInfo };
    },
    async getSignatures() {
      calls.getSignatures++;
      return { sigs: history.sigs, complete: true };
    },
    async getTransaction(sig) {
      calls.getTransaction++;
      return history.txs[sig];
    },
    async getTokenBalances() {
      return balances;
    },
  };
}

export const freshTestState = () => ({ cycle: 1, watch: {}, cooldowns: {}, bundles: {}, holders: {}, lastExit: {} });
