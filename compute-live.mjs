// Recomputes the withdrawal-queue-aware allocation fields (deployedUsd, queueAmount,
// queueBuffered, allocatable, alloc90, allocatablePct, shortfall, disassembleAmount)
// LIVE, at Allocation-routine run time, from scratch — never trusting data.json's own
// derived fields. Only `balance`/`usd` (the idle-balance read) are taken from data.json.
//
// Why: data.json has been found stripped back to a bare {balance, usd, alloc90} shape
// twice now (commit 70648f4 on 2026-09-22, commit 8d0f008 on 2026-09-23), both authored
// under the repo owner's own git identity by an unidentified process — ruled out so far:
// this repo's own GitHub Actions workflow, and local cron/launchd on the owner's machine.
// Root cause still unknown. Rather than keep chasing it or leaving the Allocation routine
// to stop and page a human every time it recurs, this script makes the routine immune to
// it: `balance` and `usd` are the one part of data.json that has survived every observed
// corruption (they're the plain idle-balance read), so this script uses only those two
// fields from the file and recomputes everything else itself, live, via the same no-auth
// public APIs refresh-data.mjs uses (Kamino for deployedUsd, Veda boringQueue for the
// withdrawal queue) — no DEBANK_API_KEY needed here since idle balance isn't re-fetched.
//
// Residual risk: if a future corruption also zeroes/mangles `balance`/`usd` themselves,
// this script still can't proceed (it has no DeBank access) and will throw, same as
// before. That failure mode has not been observed in either incident so far.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');

const KAMINO_MARKET = '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr';
const QUEUE_BUFFER_MULT = 1.20; // must match refresh-data.mjs

const VAULTS = [
  { key: 'spyx',  label: 'Kraken Earn SPYx',  symbol: 'wSPYx',  boringVault: '0x83b890ca44fb0355cdf5606617cca0fe21ddb16a', positionManager: 'HzJt4yX9AyCEFnKtTuJQto6nTpvyjVBZtrkY2ZzcoRyb' },
  { key: 'qqqx',  label: 'Kraken Earn QQQx',  symbol: 'wQQQx',  boringVault: '0x6d33d2142a5b0b52856a6902eb6f6203b2232a5b', positionManager: '8tRwmexXaSStiSK29sixkCbDJciqA8DGgLKrW2JEw2QC' },
  { key: 'nvdax', label: 'Kraken Earn NVDAx', symbol: 'wNVDAx', boringVault: '0xbeb4a79e150564857488e6142d26787a78d54a66', positionManager: 'FTeDtYDsHotvxdLBqpAccPsYrtU5VDfjZjrZUENC1fpD' },
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

function floor6(n) {
  return Math.floor(n * 1e6) / 1e6;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const byKey = Object.fromEntries((raw.vaults || []).map(v => [v.key, v]));

  const results = [];
  for (const vault of VAULTS) {
    const rec = byKey[vault.key];
    if (!rec || typeof rec.balance !== 'number' || typeof rec.usd !== 'number' || rec.balance <= 0) {
      throw new Error(`${vault.key}: data.json is missing a usable balance/usd — cannot recompute even live. This is a deeper problem than the field-stripping seen so far; stop and report.`);
    }
    const { balance, usd } = rec;
    const deployedUsd = await fetchKaminoNetValue(KAMINO_MARKET, vault.positionManager);
    const queueAmount = await fetchQueueAmount('ink', vault.boringVault);
    const queueBuffered = queueAmount * QUEUE_BUFFER_MULT;
    const price = balance > 0 ? usd / balance : 0;

    let allocatable = 0, alloc90 = 0, allocatablePct = 0, shortfall = 0, disassembleAmount = 0;
    if (balance >= queueBuffered) {
      allocatable = balance - queueBuffered;
      alloc90 = floor6(allocatable * 0.9);
      const allocatableUsd = allocatable * price;
      allocatablePct = (allocatableUsd + deployedUsd) > 0 ? (allocatableUsd / (allocatableUsd + deployedUsd)) * 100 : 0;
    } else {
      shortfall = queueBuffered - balance;
      disassembleAmount = floor6(queueBuffered - balance);
    }

    results.push({
      key: vault.key,
      label: vault.label,
      symbol: vault.symbol,
      balance,
      usd,
      deployedUsd,
      queueAmount,
      queueBuffered,
      allocatable,
      alloc90,
      allocatablePct,
      shortfall,
      disassembleAmount,
    });
  }

  console.log(JSON.stringify({ vaults: results, computedAt: new Date().toISOString(), sourceFetchedAt: raw.fetchedAt || null }, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
