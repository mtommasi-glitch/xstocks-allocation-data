// Refreshes data.json with each xStocks vault's idle wrapped-xStock balance on Ink, sitting in
// the vault's boring vault contract. The balance is read on-chain (ERC-20 balanceOf on Ink's
// public RPC) and priced as the underlying xStock's Jupiter price x the wrapper's
// convertToAssets rate — no DeBank, so running out of DeBank API credits can't block the
// Allocation routine (it did on 2026-10-15: every refresh failed with DeBank HTTP 403 and no
// tickets went out). alloc90 is 90% of allocatable, floored to 6 decimals (never round up —
// never allocate more than truly idle).
//
// Also computes idlePct = idleUsd / (idleUsd + deployedUsd), where deployedUsd is the vault's
// Kamino supervised-loan position's net account value (collateral − borrow), read from Kamino's
// own public obligation API (same source kraken-earn-dashboard/utils/fetchKaminoObligation.js
// uses — no API key needed, and DeBank can't see this leg at all since it only accepts EVM
// addresses, not the Solana Position Manager account). The Allocation routines use idlePct to
// skip a vault when there isn't enough idle balance, relative to the vault's size, to be worth
// moving.
//
// Also computes withdrawal-queue awareness: queueAmount (pending redemptions, native units,
// from Veda's boringQueue API — same source kraken-earn-dashboard's fetchXstocksBoringQueuePending
// uses) and queueBuffered (queueAmount × 1.20, a 20% cushion since this data is only refreshed
// hourly and the queue can grow before an OPS ticket gets executed). allocatable is idle minus
// that buffered reserve and minus a 5% idle buffer (bufferReserve, see IDLE_BUFFER_PCT) — alloc90
// and the materiality check apply to allocatable, not raw idle, so the routine never proposes
// moving idle that's needed to cover withdrawals or that would take the vault below 5% idle.
// If idle can't even cover the buffered queue, shortfall/disassembleAmount are set instead —
// this is a real scenario that already happened once (see ticket 1357, 2026-09-20: NVDAx idle
// hit 0 while its queue was 181.48) and the Allocation routines branch to a Disassemble+Withdraw
// ticket pair for that vault when this is set, overriding the normal Allocate flow entirely.
// disassembleAmount is queueBuffered minus what's already idle — the top-up needed to reach the
// buffered target, already accounting for existing idle, never more than the actual shortfall.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');

const INK_RPC = 'https://rpc-qnd.inkonchain.com';
const JUP_SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search';

const KAMINO_MARKET = '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr';

const VAULTS = [
  // token: the wrapped xStock (ERC-4626, 18 decimals) on Ink; mint: the underlying xStock on Solana (Jupiter price)
  { key: 'spyx',  label: 'Kraken Earn SPYx',  symbol: 'wSPYx',  boringVault: '0x83b890ca44fb0355cdf5606617cca0fe21ddb16a', positionManager: 'HzJt4yX9AyCEFnKtTuJQto6nTpvyjVBZtrkY2ZzcoRyb', token: '0xe7e553cd128f0011777323a0b44a7b96ea1cb540', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' },
  { key: 'qqqx',  label: 'Kraken Earn QQQx',  symbol: 'wQQQx',  boringVault: '0x6d33d2142a5b0b52856a6902eb6f6203b2232a5b', positionManager: '8tRwmexXaSStiSK29sixkCbDJciqA8DGgLKrW2JEw2QC', token: '0x4c1ae29c159838fc1b224636e28e086eb69101f7', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ' },
  { key: 'nvdax', label: 'Kraken Earn NVDAx', symbol: 'wNVDAx', boringVault: '0xbeb4a79e150564857488e6142d26787a78d54a66', positionManager: 'FTeDtYDsHotvxdLBqpAccPsYrtU5VDfjZjrZUENC1fpD', token: '0xa8ddb5cd96b5222afe198316e9a57caa642850d5', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
];

async function fetchKaminoNetValue(marketPubkey, walletAddr) {
  const url = `https://api.kamino.finance/kamino-market/${marketPubkey}/users/${walletAddr}/obligations`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kamino HTTP ${res.status}`);
  const obligations = await res.json();
  const o = Array.isArray(obligations) ? obligations[0] : null;
  const stats = o?.refreshedStats;
  if (!stats) throw new Error('Kamino returned no obligation stats');
  return parseFloat(stats.netAccountValue) || 0;
}

async function fetchQueueAmount(chain, boringVaultAddr) {
  const url = `https://api.sevenseas.capital/boringQueue/${chain}/${boringVaultAddr.toLowerCase()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Veda ${res.status}`);
  const data = await res.json();
  const openReqs = data?.Response?.open_requests || [];
  return openReqs.reduce((sum, r) => sum + parseFloat(r.wantTokenAmount || '0'), 0);
}

async function inkCall(to, data) {
  const res = await fetch(INK_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`Ink RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error || !j.result || j.result === '0x') throw new Error(`Ink RPC error: ${j.error?.message || 'empty result'}`);
  return BigInt(j.result);
}

async function fetchUnderlyingPrice(mint) {
  const res = await fetch(`${JUP_SEARCH_URL}?query=${mint}`);
  if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);
  const arr = await res.json();
  const price = Array.isArray(arr) ? arr.find(t => t.id === mint)?.usdPrice : null;
  if (!(price > 0)) throw new Error(`Jupiter returned no price for ${mint}`);
  return price;
}

function floor6(n) {
  return Math.floor(n * 1e6) / 1e6;
}

const BALANCE_OF = '0x70a08231';
const CONVERT_TO_ASSETS = '0x07a2d13a';
const ONE = 10n ** 18n;

async function fetchVaultIdle(vault) {
  const [raw, assetsPerShare, underlyingPrice] = await Promise.all([
    inkCall(vault.token, BALANCE_OF + vault.boringVault.slice(2).toLowerCase().padStart(64, '0')),
    inkCall(vault.token, CONVERT_TO_ASSETS + ONE.toString(16).padStart(64, '0')),
    fetchUnderlyingPrice(vault.mint),
  ]);
  const balance = Number(raw) / 1e18;
  const price   = underlyingPrice * Number(assetsPerShare) / 1e18; // USD per wrapped token
  return { balance, usd: balance * price };
}

const QUEUE_BUFFER_MULT = 1.20; // 20% cushion above the live queue reading — this is the one and
// only target reserve. Earlier version compounded a 10% cushion with a separate "restore to 2x"
// disassemble target, which produced a disassembleAmount roughly 2.2x the raw queue (e.g. 376 vs
// a 184 queue) — clearly excessive. Now there's exactly one number (queue x 1.20) and both
// allocatable and disassembleAmount are computed as (that number) vs. what's already idle.

// Idle buffer kept in the vault after every allocation, as a share of total vault value (idle +
// deployed). allocatable used to be everything above the queue, so an executed ticket left the
// vault at ~2-4% idle (2026-10-01: SPYx ended at 3.8%, QQQx at 2.2%). It's now only the excess
// above queueBuffered + this reserve. The buffer does not trigger a Disassemble on its own —
// only a queue shortfall does — so a vault between the two simply gets no ticket.
const IDLE_BUFFER_PCT = 5;

async function main() {
  const results = [];
  for (const vault of VAULTS) {
    const { balance, usd } = await fetchVaultIdle(vault);
    if (balance <= 0) throw new Error(`${vault.key}: no idle xStocks balance found on-chain — refusing to write a zeroed allocation`);
    const deployedUsd = await fetchKaminoNetValue(KAMINO_MARKET, vault.positionManager);
    const idlePct = (usd / (usd + deployedUsd)) * 100;

    const queueAmount   = await fetchQueueAmount('ink', vault.boringVault);
    const queueBuffered = queueAmount * QUEUE_BUFFER_MULT;

    const price = balance > 0 ? usd / balance : 0; // USD per native unit, from the idle leg itself

    const bufferReserve = price > 0 ? ((usd + deployedUsd) * IDLE_BUFFER_PCT / 100) / price : 0;

    let allocatable = 0, alloc90 = 0, allocatablePct = 0, shortfall = 0, disassembleAmount = 0;
    if (balance >= queueBuffered) {
      allocatable = Math.max(0, balance - queueBuffered - bufferReserve);
      alloc90     = floor6(allocatable * 0.9);
      const allocatableUsd = allocatable * price;
      allocatablePct = (usd + deployedUsd) > 0 ? (allocatableUsd / (usd + deployedUsd)) * 100 : 0;
    } else {
      // disassembleAmount already accounts for what's idle — it's the top-up needed to reach the
      // buffered target, not the target itself, so it's never larger than what's actually short.
      shortfall         = queueBuffered - balance;
      disassembleAmount = floor6(queueBuffered - balance);
    }

    results.push({
      key: vault.key,
      label: vault.label,
      symbol: vault.symbol,
      balance,
      usd,
      deployedUsd,
      idlePct,
      queueAmount,
      queueBuffered,
      bufferReserve,
      allocatable,
      alloc90,
      allocatablePct,
      shortfall,
      disassembleAmount,
    });
  }

  // Self-check: never write a file missing the fields the Allocation routines depend on. This
  // guards this script's own output — it can't stop something else from overwriting the file
  // afterward, but it ensures this pipeline itself never silently produces incomplete data.
  const REQUIRED_KEYS = ['key', 'label', 'symbol', 'balance', 'usd', 'deployedUsd', 'idlePct',
    'queueAmount', 'queueBuffered', 'bufferReserve', 'allocatable', 'alloc90', 'allocatablePct', 'shortfall', 'disassembleAmount'];
  for (const v of results) {
    const missing = REQUIRED_KEYS.filter(k => !(k in v));
    if (missing.length) throw new Error(`${v.key}: refusing to write — missing fields: ${missing.join(', ')}`);
  }

  const out = { vaults: results, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote', DATA_FILE, '-', JSON.stringify(out));
}

main().catch(err => { console.error(err.message); process.exit(1); });
