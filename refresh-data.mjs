// Refreshes data.json with each xStocks vault's idle wrapped-xStock balance on Ink, sitting in
// the vault's boring vault contract, read from DeBank's REST API (not raw chain RPC — this must
// be able to run from a GitHub Actions runner with plain internet access).
//
// Mirrors the same idle-balance extraction logic as kraken-earn-dashboard/server.js: for each
// vault, find the DeBank protocol whose name contains "xstocks", sum the usd-valued portfolio
// items there, and take amount/price from each item's first supply token. alloc90 is 90% of the
// summed balance, floored to 6 decimals (never round up — never allocate more than truly idle).
//
// Also computes idlePct = idleUsd / (idleUsd + deployedUsd), where deployedUsd is the vault's
// Kamino supervised-loan position's net account value (collateral − borrow), read from Kamino's
// own public obligation API (same source kraken-earn-dashboard/utils/fetchKaminoObligation.js
// uses — no API key needed, and DeBank can't see this leg at all since it only accepts EVM
// addresses, not the Solana Position Manager account). The Allocation routines use idlePct to
// skip a vault when there isn't enough idle balance, relative to the vault's size, to be worth
// moving.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');

const DEBANK_KEY = process.env.DEBANK_API_KEY;
if (!DEBANK_KEY) throw new Error('DEBANK_API_KEY not set');

const KAMINO_MARKET = '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr';

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

async function debank(endpoint, params, retriesLeft = 2) {
  const url = new URL(`https://pro-openapi.debank.com${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { AccessKey: DEBANK_KEY } });
  if (!res.ok && retriesLeft > 0) {
    await new Promise(r => setTimeout(r, 1000));
    return debank(endpoint, params, retriesLeft - 1);
  }
  if (!res.ok) throw new Error(`DeBank HTTP ${res.status} on ${endpoint}`);
  return res.json();
}

function floor6(n) {
  return Math.floor(n * 1e6) / 1e6;
}

async function fetchVaultIdle(vault) {
  const protocols = await debank('/v1/user/all_complex_protocol_list', { id: vault.boringVault });
  let balance = 0, usd = 0;
  for (const prot of protocols || []) {
    if (!prot.name?.toLowerCase().includes('xstocks')) continue;
    for (const item of prot.portfolio_item_list || []) {
      const itemUsd = item.stats?.net_usd_value || 0;
      if (itemUsd < 1) continue;
      const tok = item.detail?.supply_token_list?.[0];
      if (!tok) continue;
      balance += tok.amount || 0;
      usd += itemUsd;
    }
  }
  return { balance, usd };
}

async function main() {
  const results = [];
  for (const vault of VAULTS) {
    const { balance, usd } = await fetchVaultIdle(vault);
    if (balance <= 0) throw new Error(`${vault.key}: no idle xStocks balance found on DeBank — refusing to write a zeroed allocation`);
    const deployedUsd = await fetchKaminoNetValue(KAMINO_MARKET, vault.positionManager);
    const idlePct = (usd / (usd + deployedUsd)) * 100;
    results.push({
      key: vault.key,
      label: vault.label,
      symbol: vault.symbol,
      balance,
      usd,
      alloc90: floor6(balance * 0.9),
      deployedUsd,
      idlePct,
    });
  }

  const out = { vaults: results, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote', DATA_FILE, '-', JSON.stringify(out));
}

main().catch(err => { console.error(err.message); process.exit(1); });
