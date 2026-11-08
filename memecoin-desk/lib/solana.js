// Minimal Solana helpers with no dependencies; runs in Node 18+ and modern browsers.
import { sleep } from './util.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// ---------- base58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP.get(c);
    if (v === undefined) throw new Error(`invalid base58 character "${c}"`);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export const isAddress = (s) => {
  try {
    return typeof s === 'string' && base58Decode(s).length === 32;
  } catch {
    return false;
  }
};

// ---------- ed25519 "is on curve" (needed for program-derived addresses) ----------
const P = 2n ** 255n - 19n;
const mod = (a) => {
  const r = a % P;
  return r < 0n ? r + P : r;
};
const pow = (b, e) => {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
};
const D = mod(-121665n * pow(121666n, P - 2n));

export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}

const utf8 = new TextEncoder();
const PDA_MARKER = utf8.encode('ProgramDerivedAddress');

export async function findProgramAddress(seeds, programId) {
  const program = base58Decode(programId);
  const seedBytes = seeds.map((s) => (typeof s === 'string' ? utf8.encode(s) : s));
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seedBytes, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.length;
    }
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf));
    if (!isOnCurve(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error('no viable bump seed');
}

export const pumpBondingCurve = async (mint) => (await findProgramAddress(['bonding-curve', base58Decode(mint)], PUMP_PROGRAM)).address;

// ---------- JSON-RPC client ----------
export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message || JSON.stringify(error)}`);
    this.name = 'RpcError';
    this.code = error?.code;
  }
}

const HEAVY_METHODS = new Set(['getTransaction', 'getSignaturesForAddress', 'getTokenAccountsByOwner']);

export class Rpc {
  constructor(http, { url, minIntervalMs = 150, txMinIntervalMs = 1100 } = {}) {
    this.http = http;
    this.url = url;
    this.calls = 0;
    http.setInterval('rpc', minIntervalMs);
    http.setInterval('rpc:getTransaction', txMinIntervalMs);
    http.setInterval('rpc:getSignaturesForAddress', minIntervalMs ? Math.max(minIntervalMs, 400) : 0);
    http.setInterval('rpc:getTokenAccountsByOwner', minIntervalMs ? Math.max(minIntervalMs, 300) : 0);
  }

  async call(method, params, { retries = 4 } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (HEAVY_METHODS.has(method)) await sleep(this.http.reserve(`rpc:${method}`));
      this.calls++;
      const res = await this.http.json(this.url, { method: 'POST', body: { jsonrpc: '2.0', id: this.calls, method, params }, key: 'rpc' });
      if (!res.error) return res.result;
      const code = res.error.code;
      const rateLimited = code === 429 || code === -32429 || /too many requests/i.test(res.error.message || '');
      const transient = rateLimited || code === -32005 || code === -32603 || code === -32004 || code === -32014;
      if (transient && attempt < retries) {
        const wait = Math.min(30_000, 1500 * 2 ** attempt);
        this.http.pushBack(rateLimited && HEAVY_METHODS.has(method) ? `rpc:${method}` : 'rpc', wait);
        await sleep(wait);
        continue;
      }
      throw new RpcError(method, res.error);
    }
  }

  async getMint(mint) {
    const res = await this.call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const parsed = res?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') throw new Error(`${mint} is not a token mint`);
    const info = parsed.info;
    return {
      program: res.value.data.program, // 'spl-token' | 'spl-token-2022'
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      supply: info.supply, // raw integer string
      decimals: info.decimals,
      extensions: info.extensions || [],
    };
  }

  // Walks signature history newest -> oldest. `complete` is true when the very first signature was reached.
  async getSignatures(address, { maxPages = 10, pageSize = 1000 } = {}) {
    const sigs = [];
    let before;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.call('getSignaturesForAddress', [address, { limit: pageSize, commitment: 'confirmed', ...(before ? { before } : {}) }]);
      sigs.push(...batch);
      if (batch.length < pageSize) return { sigs, complete: true };
      before = batch[batch.length - 1].signature;
    }
    return { sigs, complete: false };
  }

  getTransaction(signature) {
    return this.call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  }

  // mint -> ui balance, for every non-empty token account the owner has (SPL + Token-2022).
  async getTokenBalances(owner) {
    const out = new Map();
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const res = await this.call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const acc of res?.value || []) {
        const info = acc.account?.data?.parsed?.info;
        const amount = Number(info?.tokenAmount?.uiAmount || 0);
        if (info?.mint && amount > 0) out.set(info.mint, (out.get(info.mint) || 0) + amount);
      }
    }
    return out;
  }
}

// Token-2022 extensions that let someone other than the holder move, tax, block or freeze tokens.
export function dangerousExtensions(extensions = []) {
  const bad = [];
  for (const ext of extensions) {
    const s = ext.state || {};
    switch (ext.extension) {
      case 'permanentDelegate':
        if (s.delegate) bad.push('permanent delegate');
        break;
      case 'transferHook':
        if (s.programId) bad.push('transfer hook');
        break;
      case 'transferFeeConfig': {
        const bps = Math.max(s.newerTransferFee?.transferFeeBasisPoints || 0, s.olderTransferFee?.transferFeeBasisPoints || 0);
        if (bps > 0) bad.push(`transfer fee ${bps / 100}%`);
        else if (s.transferFeeConfigAuthority) bad.push('transfer fee can be enabled');
        break;
      }
      case 'nonTransferable':
        bad.push('non-transferable');
        break;
      case 'defaultAccountState':
        if (s.accountState === 'frozen') bad.push('accounts frozen by default');
        break;
      case 'pausableConfig':
        if (s.authority) bad.push('pausable');
        break;
      default:
        break;
    }
  }
  return bad;
}
