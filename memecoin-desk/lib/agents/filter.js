// Agent 2 - Filter. Kills anything that fails a safety or liquidity rule. Checks run cheapest first:
//   1. market   (DexScreener):         liquidity, 1h volume, already +80% in 1h
//   2. on-chain (RPC mint + RugCheck): mint/freeze authority, LP burned/locked, top 10, dev %, dev past rugs, insider clusters
//   3. launch   (RPC history):         share of supply bought in the creation slot (bundled launch)
import { STAGE, expectStage, handoff } from '../handoff.js';
import { dangerousExtensions, pumpBondingCurve } from '../solana.js';
import { fmtUsd, num, round, shortAddr } from '../util.js';

// Accounts that hold tokens on behalf of pools/launchpads, never a person.
export const PROGRAM_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', // Raydium LaunchLab
  'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', // Meteora DAMM v2
  'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', // Meteora DBC
]);
const POOL_ACCOUNT_TYPES = new Set(['AMM', 'LOCKER', 'CLOB']);

export class Filter {
  constructor({ cfg, rpc, rug }) {
    this.cfg = cfg;
    this.rpc = rpc;
    this.rug = rug;
  }

  async run(report, state) {
    expectStage('filter', report, STAGE.SCOUTED);
    const f = this.cfg.filter;
    const p = report.pair;
    const metrics = {
      liquidityUsd: round(p.liquidityUsd, 0),
      volume1hUsd: round(p.volume.h1, 0),
      priceChange1hPct: p.priceChange.h1,
      mcapUsd: round(report.mcapUsd, 0),
      ageMin: round(report.ageMin, 0),
    };

    // ---- stage 1: market (free, already in hand) ----
    const reasons = [];
    if (p.liquidityUsd < f.minLiquidityUsd) reasons.push(reason('low_liquidity', `liquidity ${fmtUsd(p.liquidityUsd)} < ${fmtUsd(f.minLiquidityUsd)}`));
    if (p.volume.h1 < f.minVolume1hUsd) reasons.push(reason('low_volume_1h', `1h volume ${fmtUsd(p.volume.h1)} < ${fmtUsd(f.minVolume1hUsd)}`));
    if (p.priceChange.h1 >= f.maxPriceChange1hPct) reasons.push(reason('pumped_1h', `already +${round(p.priceChange.h1, 1)}% in 1h (limit +${f.maxPriceChange1hPct}%)`));
    if (reasons.length) return this.kill(reasons, metrics, ['market']);

    // ---- stage 2: on-chain safety ----
    let mint = null;
    let mintError = null;
    try {
      mint = await this.rpc.getMint(report.mint);
    } catch (err) {
      mintError = err.message;
    }
    let rc;
    try {
      rc = await this.rug.report(report.mint);
    } catch (err) {
      return this.kill([reason('unverifiable', `RugCheck report unavailable (${err.message})`, { retry: true })], metrics, ['market', 'onchain']);
    }

    const supply = num(mint?.supply ?? rc?.token?.supply, 0);
    if (!(supply > 0)) return this.kill([reason('unverifiable', `token supply unknown (${mintError || 'no mint data'})`, { retry: true })], metrics, ['market', 'onchain']);
    const authoritySource = mint ? 'rpc' : 'rugcheck';
    const mintAuthority = mint ? mint.mintAuthority : rc.token?.mintAuthority ?? null;
    const freezeAuthority = mint ? mint.freezeAuthority : rc.token?.freezeAuthority ?? null;
    Object.assign(metrics, { mintAuthority, freezeAuthority, authoritySource, tokenProgram: mint?.program || rc.tokenProgram });

    if (f.requireMintRevoked && mintAuthority) reasons.push(reason('mint_authority', `mint authority not revoked (${shortAddr(mintAuthority)})`));
    if (f.requireFreezeRevoked && freezeAuthority) reasons.push(reason('freeze_authority', `freeze authority not revoked (${shortAddr(freezeAuthority)})`));
    const badExt = f.killDangerousToken2022 && mint ? dangerousExtensions(mint.extensions) : [];
    if (badExt.length) reasons.push(reason('token2022_extension', `Token-2022 ${badExt.join(', ')}`, { permanent: true }));

    // LP: judge the pool we would trade in (falls back to the deepest market RugCheck knows).
    const markets = rc.markets || [];
    const marketLiq = (m) => num(m.lp?.baseUSD) + num(m.lp?.quoteUSD);
    const mainMarket = markets.find((m) => m.pubkey === p.address) || markets.slice().sort((a, b) => marketLiq(b) - marketLiq(a))[0];
    if (!mainMarket) reasons.push(reason('unverifiable', 'no pool/LP data from RugCheck', { retry: true }));
    else {
      const locked = num(mainMarket.lp?.lpLockedPct);
      metrics.lpLockedPct = round(locked, 2);
      metrics.lpMarket = mainMarket.marketType;
      if (locked < f.minLpLockedPct) reasons.push(reason('lp_not_locked', `main pool LP ${round(locked, 1)}% burned/locked < ${f.minLpLockedPct}% (${mainMarket.marketType})`));
    }

    // Top 10: real wallets only (pool vaults, lockers and order books removed).
    const isPump = isPumpToken(report, rc);
    const curve = isPump ? await pumpBondingCurve(report.mint) : null;
    const poolAccounts = poolAccountSet(report, rc, curve);
    const holders = (rc.topHolders || []).filter((h) => !poolAccounts.has(h.owner) && !poolAccounts.has(h.address));
    if (!rc.topHolders?.length) reasons.push(reason('unverifiable', 'no holder data from RugCheck', { retry: true }));
    else {
      const top10 = holders.slice(0, 10).reduce((s, h) => s + num(h.pct), 0);
      metrics.top10Pct = round(top10, 2);
      if (top10 > f.maxTop10Pct) reasons.push(reason('top10_concentration', `top 10 wallets hold ${round(top10, 1)}% > ${f.maxTop10Pct}%`));
    }

    // Dev: holdings and history. If RugCheck's "creator" is a launchpad program, the real dev is resolved in stage 3.
    const creatorIsProgram = PROGRAM_AUTHORITIES.has(rc.creator);
    metrics.creator = rc.creator;
    if (!creatorIsProgram) {
      let devPct = (num(rc.creatorBalance) / supply) * 100;
      const asHolder = (rc.topHolders || []).find((h) => h.owner === rc.creator);
      if (asHolder) devPct = Math.max(devPct, num(asHolder.pct));
      metrics.devPct = round(devPct, 3);
      if (devPct > f.maxDevPct) reasons.push(reason('dev_holding', `dev wallet holds ${round(devPct, 2)}% > ${f.maxDevPct}%`));
    }
    const rugRisk = (rc.risks || []).find((r) => /rug/i.test(r.name || ''));
    metrics.creatorTokens = Array.isArray(rc.creatorTokens) ? rc.creatorTokens.length : 0;
    if (f.killDevPastRugs && !creatorIsProgram && rugRisk) reasons.push(reason('dev_past_rugs', `${rugRisk.name}${metrics.creatorTokens ? ` (${metrics.creatorTokens} other launches)` : ''}`, { permanent: true }));
    if (f.killDevPastRugs && rc.rugged) reasons.push(reason('dev_past_rugs', 'RugCheck marks this token as rugged', { permanent: true }));

    // Insider clusters: wallets linked by transfers (bundles dispersed into many wallets to dodge the top 10 check).
    const clusterPct = ((rc.insiderNetworks || []).reduce((s, n) => s + num(n.currentHolding), 0) / supply) * 100;
    metrics.insiderClusterPct = round(clusterPct, 2);
    metrics.insiderWallets = num(rc.graphInsidersDetected);
    if (f.bundle.includeInsiderClusters && clusterPct > f.maxBundledPct) {
      const nets = (rc.insiderNetworks || []).length;
      reasons.push(reason('bundled_launch', `${nets} insider wallet cluster${nets === 1 ? '' : 's'} hold ${round(clusterPct, 1)}% > ${f.maxBundledPct}%`));
    }

    metrics.holders = num(rc.totalHolders);
    recordHolders(state, report.mint, metrics.holders);
    if (reasons.length) return this.kill(reasons, metrics, ['market', 'onchain']);

    // ---- stage 3: launch bundle (on-chain, cached forever per token) ----
    let bundle = state.bundles[report.mint];
    if (!bundle || bundle.status === 'error') {
      bundle = await this.launchBundle(report, { rc, curve, poolAccounts, supply });
      state.bundles[report.mint] = bundle;
    }
    metrics.bundle = summarizeBundle(bundle);
    if (bundle.status === 'ok') {
      if (bundle.pct > f.maxBundledPct) {
        reasons.push(reason('bundled_launch', `${round(bundle.pct, 1)}% of supply bought in the launch slot by ${bundle.buyers} wallets (${bundle.txs} txs) > ${f.maxBundledPct}%`, { permanent: true }));
      } else if (bundle.partial) {
        reasons.push(reason('unverifiable', `launch slot has ${bundle.totalLaunchTxs} txs; only ${bundle.txs} checked (${round(bundle.pct, 1)}% so far)`, { permanent: true }));
      }
    } else if (f.bundle.killIfUnverifiable) {
      reasons.push(reason('unverifiable', `launch bundle: ${bundle.note}`, { retry: bundle.status === 'error', permanent: bundle.status !== 'error' }));
    }

    // Dev holdings when RugCheck only knows the launchpad program: use the wallet that signed the create tx.
    if (creatorIsProgram && bundle.creator && !reasons.length) {
      try {
        const bal = await this.rpc.getTokenBalances(bundle.creator);
        const raw = (bal.get(report.mint) || 0) * 10 ** num(mint?.decimals ?? rc.token?.decimals, 6);
        const devPct = (raw / supply) * 100;
        metrics.creator = bundle.creator;
        metrics.devPct = round(devPct, 3);
        if (devPct > f.maxDevPct) reasons.push(reason('dev_holding', `dev wallet ${shortAddr(bundle.creator)} holds ${round(devPct, 2)}% > ${f.maxDevPct}%`));
      } catch (err) {
        reasons.push(reason('unverifiable', `dev balance lookup failed (${err.message})`, { retry: true }));
      }
    } else if (creatorIsProgram) {
      metrics.devPct = null;
      metrics.devNote = 'launchpad creator; launch signer unknown';
    }

    if (reasons.length) return this.kill(reasons, metrics, ['market', 'onchain', 'launch']);

    return {
      verdict: 'pass',
      candidate: handoff({ ...report, safety: metrics }, 'filter', STAGE.FILTERED),
      metrics,
    };
  }

  // Share of total supply bought in the token's creation slot (Jito-bundle window).
  async launchBundle(report, { rc, curve, poolAccounts, supply }) {
    const b = this.cfg.filter.bundle;
    const anchor = curve || report.oldestPair?.address;
    const method = curve ? 'pump.fun bonding curve' : `first pool (${report.oldestPair?.dexId || '?'})`;
    if (!anchor) return { status: 'unverifiable', note: 'no launch account to trace', method };
    try {
      const { sigs, complete } = await this.rpc.getSignatures(anchor, { maxPages: b.maxSignaturePages });
      if (!complete) return { status: 'unverifiable', note: `launch account has more than ${b.maxSignaturePages * 1000} transactions`, method, anchor };
      const ok = sigs.filter((s) => !s.err);
      if (!ok.length) return { status: 'unverifiable', note: 'no successful transactions on launch account', method, anchor };
      const slot = ok[ok.length - 1].slot;
      const launch = ok.filter((s) => s.slot <= slot + b.slotWindow).reverse();
      const checked = launch.slice(0, b.maxLaunchTxs);
      const exclude = new Set([...poolAccounts, anchor]);
      let bought = 0;
      let creator = null;
      const buyers = new Set();
      for (const s of checked) {
        const tx = await this.rpc.getTransaction(s.signature);
        if (!tx || tx.meta?.err) continue;
        if (!creator) creator = tx.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey || null;
        if ((tx.meta.logMessages || []).some((l) => /Instruction: Migrat/i.test(l))) continue; // pool migration, not a buy
        const keys = tx.transaction?.message?.accountKeys || [];
        const pre = new Map();
        for (const tb of tx.meta.preTokenBalances || []) if (tb.mint === report.mint) pre.set(tb.accountIndex, num(tb.uiTokenAmount?.amount));
        for (const tb of tx.meta.postTokenBalances || []) {
          if (tb.mint !== report.mint || !tb.owner) continue;
          const account = keys[tb.accountIndex]?.pubkey;
          if (exclude.has(tb.owner) || exclude.has(account)) continue;
          const delta = num(tb.uiTokenAmount?.amount) - (pre.get(tb.accountIndex) || 0);
          if (delta > 0) {
            bought += delta;
            buyers.add(tb.owner);
          }
        }
      }
      return {
        status: 'ok',
        pct: (bought / supply) * 100,
        buyers: buyers.size,
        txs: checked.length,
        totalLaunchTxs: launch.length,
        partial: launch.length > checked.length,
        slot,
        creator,
        method,
        anchor,
        checkedAt: Date.now(),
      };
    } catch (err) {
      return { status: 'error', note: `RPC error (${err.message})`, method, anchor };
    }
  }

  kill(reasons, metrics, stagesRun) {
    const f = this.cfg.filter;
    const permanent = reasons.some((r) => r.permanent);
    const retryOnly = reasons.every((r) => r.retry);
    const ttlMin = permanent ? Infinity : retryOnly ? f.unverifiableRetryMinutes : f.recheckMinutes;
    return { verdict: 'kill', reasons, metrics, stagesRun, ttlMin };
  }
}

const reason = (rule, detail, flags = {}) => ({ rule, detail, ...flags });

export const isPumpToken = (report, rc) =>
  report.mint.endsWith('pump') || rc?.launchpad?.platform === 'pump_fun' || report.dexIds?.includes('pumpfun') || report.dexIds?.includes('pumpswap');

export function poolAccountSet(report, rc, curve) {
  const set = new Set([...PROGRAM_AUTHORITIES, ...(report.pairAddresses || [])]);
  if (curve) set.add(curve);
  for (const m of rc?.markets || []) for (const a of [m.pubkey, m.liquidityA, m.liquidityB]) if (a) set.add(a);
  for (const [addr, info] of Object.entries(rc?.knownAccounts || {})) if (POOL_ACCOUNT_TYPES.has(info?.type)) set.add(addr);
  return set;
}

function recordHolders(state, mint, count) {
  if (!(count > 0)) return;
  const list = (state.holders[mint] ||= []);
  const last = list[list.length - 1];
  if (last && last[1] === count && Date.now() - last[0] < 120_000) return;
  list.push([Date.now(), count]);
  if (list.length > 40) list.splice(0, list.length - 40);
}

function summarizeBundle(b) {
  if (!b) return null;
  if (b.status !== 'ok') return { status: b.status, note: b.note, method: b.method };
  return { status: 'ok', pct: round(b.pct, 2), buyers: b.buyers, txs: b.txs, slot: b.slot, method: b.method, partial: b.partial || undefined };
}
