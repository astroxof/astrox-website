# Memecoin Desk

A Solana memecoin paper-trading desk that looks for the strongest fresh coins using on-chain data. Six agents run in a fixed order with hard handoffs:

```
Scout ──► Filter ──► Analyst ──► Executor ──► Risk ──► Executor ──► Logger
 find      kill       score       ticket      arm        fill        record
                                              stop
```

Each agent only accepts an item in the stage the previous agent left it in (`lib/handoff.js`). Nothing can skip the Filter or the Analyst, and the Executor refuses to fill a ticket unless Risk has already armed a stop. The agents are deterministic code, not LLM prompts: every kill and every score can be traced to a number in the log.

**Paper only.** No wallet, no private key, no real orders. This build has no live broker.

## The rules

All thresholds live in [`lib/config.js`](lib/config.js).

| Agent | Rule | Data source |
|---|---|---|
| **Scout** | Pairs 30m–72h old, market cap $300k–$20M, traded against SOL | DexScreener (profiles, boosts, takeovers, `tokens/v1`), GeckoTerminal trending and top pools for discovery |
| **Filter** | Mint or freeze authority not revoked | Solana RPC `getAccountInfo` on the mint (RugCheck as fallback) |
| | LP not burned or locked (main pool < 90%) | RugCheck markets |
| | Liquidity < $40k, 1h volume < $50k, already +80% in 1h | DexScreener main pair |
| | Top 10 wallets > 25% (pool vaults, lockers and order books excluded) | RugCheck top holders |
| | Dev holds > 3%, or the dev has past rugs | RugCheck creator balance and "Creator history of rugged tokens" |
| | Bundled launch > 10% | **On-chain**: share of supply bought in the creation slot, see below. Also RugCheck transfer-linked insider clusters |
| | Dangerous Token-2022 extensions (permanent delegate, transfer hook, transfer fee, default-frozen) | Solana RPC (part of the authority check) |
| **Analyst** | Score 0–100; only 70+ passes | momentum (DexScreener 5m/1h/6h + volume acceleration), unique buyers and buy/sell ratio by distinct wallets (GeckoTerminal), holder growth (RugCheck counts between scans), liq/mcap, smart wallets (your list, on-chain balances) |
| **Executor** | Max 8% of equity per trade | paper broker |
| **Risk** | Stop −6% armed before entry; trailing stop after +12% (follows the peak at 6%) | DexScreener price every 15s |
| **Logger** | Every handoff, kill, fill and exit | `logs/*.jsonl`, `logs/kills-*.csv`, dashboard |

### How "bundled launch" is measured

For pump.fun coins the desk derives the bonding-curve account (a program-derived address), walks its transaction history back to the creation transaction, and fetches every successful transaction in that creation slot. It adds up the tokens that landed in real wallets: pool vaults, the curve and the migration transaction are excluded. That sum as a share of supply is the launch bundle. The result never changes, so it is cached per coin.

Other launchpads are traced through the coin's first pool the same way. If the creation slot can't be reached within 10,000 transactions, the coin is killed as *unverifiable*. The Filter fails closed. Set `filter.bundle.killIfUnverifiable` to `false` to change that.

RugCheck's insider clusters (wallets linked by transfers) count too. They catch bundles that were split across hundreds of wallets to slip past the top-10 check.

### Kill cooldowns

Coins killed on rules that can change (liquidity, volume, top 10, score) are re-tested after 15 minutes. Coins killed for a bundled launch, dev past rugs or a dangerous Token-2022 extension are never re-tested in that session. Coins that couldn't be checked because of a data error are retried after 5 minutes.

## Run it overnight (Node)

Needs Node.js 18.17 or newer. There are no dependencies to install.

```bash
cd memecoin-desk
node desk.mjs --hours 9
```

- Live dashboard: <http://localhost:8787>, the same page as GitHub Pages in viewer mode.
- Every event goes to `logs/desk-YYYY-MM-DD.jsonl`, and kills also go to `logs/kills-YYYY-MM-DD.csv`, which opens in Excel.
- When the time is up, or on Ctrl+C, it writes `logs/report-….md`: equity, PnL, win rate, kills by rule, every trade.
- The paper account is saved in `state/paper-state.json`. Restarting resumes it, including open positions and their stops.

| Flag | |
|---|---|
| `--hours N` | stop by itself after N hours and write the report |
| `--fresh` | start a new paper account (the old one is backed up) |
| `--flatten` | close open positions at market when stopping |
| `--report` | print the report for the saved account and exit |
| `--once` | run one cycle and exit (smoke test) |
| `--port N` | dashboard port, `0` to disable |
| `--verbose` | also print rate-limit retries |

### Settings: `config.local.json`

Optional. Same shape as `lib/config.js`; only what you set is overridden. It is git-ignored.

```json
{
  "rpc": { "url": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY", "minIntervalMs": 120, "txMinIntervalMs": 250 },
  "paper": { "startingSol": 10 },
  "smartWallets": {
    "wallets": [
      { "address": "WALLET_ADDRESS_1", "label": "kol-1" },
      { "address": "WALLET_ADDRESS_2", "label": "early-buyer" }
    ]
  }
}
```

- **RPC**: the public Solana RPC works but is slow and throttles `getTransaction`. A free key from a provider such as Helius makes the launch-bundle check much faster. `RPC_URL=… node desk.mjs` works too.
- **Smart wallets**: add wallets you trust as smart money (from GMGN, Cielo, your own research). Their token balances are read on-chain every 5 minutes. With no list, that component is left out and the other five are re-weighted.

### Keep the computer awake

On Windows, set *Settings → System → Power → Sleep* to *Never* for the night, or run `powercfg /change standby-timeout-ac 0` and restore it in the morning. On macOS, run `caffeinate -i node desk.mjs --hours 9`.

## Run it in the browser

`index.html` runs the same engine in the tab. Once this folder is on GitHub Pages it is at `https://astroxof.github.io/astrox-website/memecoin-desk/`.

1. Open **Settings** and paste an RPC URL. The public Solana RPC refuses requests from web pages, so this one is required.
2. Press **Start**. The paper account lives in this browser's storage. **Report** downloads the markdown report, and **Export log** downloads the JSONL log.

Browsers pause hidden tabs and phones suspend them, so for unattended overnight runs use the Node runner.

## Paper fills

Fills model real costs: a 1% DEX fee and 0.5% slippage per side, 0.002 SOL network fee per transaction, and constant-product price impact from the pool's SOL reserve. Stops are checked every 15 seconds and fill at the observed price, so a gap through the stop is booked as the larger loss it would be. A flat round trip costs about 3–4%.

## Tests

```bash
cd memecoin-desk
npm test        # or: node --test
```

The tests cover each Filter rule, the launch-bundle math (including migrations, pool vaults and failed sniper transactions), Analyst scoring, sizing, the stop-before-entry handoff, stop/trail/drain exits, and a full desk cycle against a fake network. The pump.fun PDA test vectors are real mainnet curve accounts.

## Limits worth knowing

- Discovery covers what DexScreener and GeckoTerminal surface (profiles, boosts, trending, top pools), not every new pair on Solana.
- Unique buyers, holder counts and LP lock status come from GeckoTerminal and RugCheck, which index the chain. Mint/freeze authority, the launch bundle and smart-wallet balances are read straight from the RPC.
- Paper results flatter real trading: no failed transactions, no MEV, no latency spikes.

Nothing here is financial advice. Most memecoins go to zero.
