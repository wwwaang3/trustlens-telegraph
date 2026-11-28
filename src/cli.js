#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { TrustLensEngine } from './engine.js';
import { MISSION07_PRESETS } from './fixtures.js';
import { formatReceiptMarkdown } from './receipts.js';
import { TelegraphClient } from './telegraph.js';
import { getX402UsdcBalance } from './x402.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional[0] || 'help', positional: positional.slice(1), flags };
}

async function cmdProbe() {
  const cfg = getConfig();
  const client = new TelegraphClient(cfg);
  console.log(`\n[TrustLens] Probing live Telegraph node: ${cfg.nodeUrl}`);
  const [intentsData, probe] = await Promise.all([
    client.getLiveIntents(),
    client.probeAsk('Fact-check: Water boils at 100 degrees Celsius at 1 atm.'),
  ]);

  const m07 = ['FACT_CHECK_GENERAL', 'URL_SAFE_GENERAL', 'AI_TEXT_DETECTION_GENERAL', 'CONTENT_VERIFICATION_GENERAL', 'MEDIA_FORENSIC_VERIFY_GENERAL', 'PRODUCT_AUTHENTICITY_GENERAL'];
  console.log(`Live canonical intents on node: ${intentsData.count}`);
  console.log('Mission 07 specialist supply:');
  for (const id of m07) {
    const hit = (intentsData.intents || []).find((x) => x.intent_id === id);
    console.log(`  - ${id.padEnd(32)} miners=${hit?.miner_count ?? 0} (${hit?.lifecycle_state ?? 'n/a'})`);
  }
  console.log('\nLive x402 v2 Challenge (/engine/v1/ask):');
  console.log(JSON.stringify(probe, null, 2));

  if (client.hasEscrowKey) {
    try {
      const escrow = await client.getEscrowBalance();
      console.log(`\nConfigured Telegraph Escrow API: ACTIVE (${cfg.backendUrl})`);
      console.log(`Telegraph Escrow Balance: $${Number(escrow.effectiveBalance ?? escrow.escrowBalance ?? 0).toFixed(4)} USDC (Sepolia testnet)`);
    } catch (e) {
      console.log(`\nTelegraph Escrow Balance Check Failed: ${e.message}`);
    }
  }
  if (client.payerAddress) {
    const bal = await getX402UsdcBalance(client.payerAddress, cfg.rpcUrl, cfg.chainId);
    console.log(`\nConfigured Base Sepolia x402 Wallet: ${client.payerAddress}`);
    console.log(`Base Sepolia Circle USDC Balance: $${bal.usd.toFixed(4)} USDC`);
  }
  if (!client.canPayLive) {
    console.log('\nPayment Rail: Not configured (probe/fixture modes work; set ANJOMAN_API_KEY or AGENT_PRIVATE_KEY in .env for live paid calls).');
  }
}

async function cmdCheck(flags) {
  const mode = flags.mode || (flags.live ? 'live' : flags.probe ? 'probe' : 'fixture');
  const engine = new TrustLensEngine();

  let input;
  if (flags.preset) {
    const p = MISSION07_PRESETS[flags.preset];
    if (!p) {
      console.error(`Unknown preset '${flags.preset}'. Valid: ${Object.keys(MISSION07_PRESETS).join(', ')}`);
      process.exit(1);
    }
    input = { ...p.input, presetId: p.id };
  } else {
    input = {
      claim: flags.claim || '',
      url: flags.url || '',
      productCode: flags.product || '',
      textSample: flags.text || '',
      mediaUrl: flags.media || '',
    };
  }

  if (flags.budget !== undefined) {
    input.maxBudgetUsdc = Number.parseFloat(flags.budget);
  }
  if (flags['simulate-failure']) {
    input.simulateUpstreamFailure = true;
  }

  const receipt = await engine.verify(input, {
    mode,
    verifyOnChain: flags['no-chain-verify'] !== true,
    recordLedger: true,
  });

  if (flags.out) {
    const outPath = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    console.log(`Saved receipt JSON to ${outPath}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log('\n' + formatReceiptMarkdown(receipt) + '\n');
  }
}

async function cmdPresets(flags) {
  const mode = flags.mode || (flags.live ? 'live' : 'fixture');
  const engine = new TrustLensEngine();
  console.log(`\n=== Running all ${Object.keys(MISSION07_PRESETS).length} Mission 07 Presets (mode=${mode}) ===\n`);

  for (const preset of Object.values(MISSION07_PRESETS)) {
    const receipt = await engine.verify(
      { ...preset.input, presetId: preset.id },
      { mode, verifyOnChain: mode === 'live' && flags['no-chain-verify'] !== true, recordLedger: true },
    );
    const match = receipt.verdict === preset.expectedVerdict ? 'PASS' : 'DIFF';
    console.log(
      `[${match}] ${preset.id.padEnd(22)} verdict=${receipt.verdict.padEnd(10)} action=${receipt.action.padEnd(30)} cost=$${receipt.accounting.totalCostUsd.toFixed(4)}`,
    );
  }

  const summary = engine.getLedgerSummary();
  console.log('\nLedger Summary:', JSON.stringify({ ...summary, recent: undefined }, null, 2));
}

function cmdLedger() {
  const engine = new TrustLensEngine();
  console.log(JSON.stringify(engine.getLedgerSummary(), null, 2));
}

function printHelp() {
  console.log(`TrustLens CLI — Telegraph Protocol Season II (Mission 07: Consumer Platform)

Commands:
  probe                                      Live probe of devnode intents + HTTP 402 x402 challenge
  check --preset <id> [--mode live|probe|fixture] [--budget 0.05] [--out file.json] [--json]
  check --claim "..." [--url "https://..."] [--mode live|probe|fixture] [--budget 0.05]
  presets [--mode fixture|live]              Run all 6 Mission 07 test presets (incl. UNKNOWN & failure cases)
  ledger                                     Show cumulative accounting & verdict metrics

Presets: ${Object.keys(MISSION07_PRESETS).join(', ')}
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'probe') return cmdProbe();
  if (command === 'check') return cmdCheck(flags);
  if (command === 'presets') return cmdPresets(flags);
  if (command === 'ledger') return cmdLedger();
  printHelp();
}

main().catch((err) => {
  console.error(`[TrustLens Error] ${err.message || err}`);
  process.exit(1);
});
