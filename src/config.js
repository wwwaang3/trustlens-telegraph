import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/** Minimal zero-dependency .env loader (does not overwrite existing env vars). */
export function loadDotEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

export const BASE_SEPOLIA = {
  chainId: 84532,
  network: 'eip155:84532',
  rpcUrl: 'https://sepolia.base.org',
  basescanUrl: 'https://sepolia.basescan.org',
  usdcX402: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export function getConfig() {
  const nodeUrl = (process.env.TELEGRAPH_NODE_URL || 'https://devnode.telegraphprotocol.com').replace(/\/+$/, '');
  const backendUrl = (process.env.TELEGRAPH_BACKEND_URL || 'https://backend.telegraphprotocol.com').replace(/\/+$/, '');
  const anjomanApiKey = (process.env.ANJOMAN_API_KEY || '').trim();
  const agentPrivateKey = (process.env.AGENT_PRIVATE_KEY || '').trim();
  const preferredRail = (process.env.TELEGRAPH_PAYMENT_RAIL || '').trim().toLowerCase();

  return {
    nodeUrl,
    backendUrl,
    engineUrl: `${nodeUrl}/engine`,
    dispatcherUrl: `${nodeUrl}/miner-dispatcher`,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || process.env.RPC_URL || BASE_SEPOLIA.rpcUrl,
    chainId: Number.parseInt(process.env.TELEGRAPH_CHAIN_ID || process.env.CHAIN_ID || String(BASE_SEPOLIA.chainId), 10),
    anjomanApiKey,
    agentPrivateKey,
    preferredRail: preferredRail || (anjomanApiKey ? 'escrow' : agentPrivateKey ? 'x402' : 'none'),
    maxCheckBudgetUsdc: Number.parseFloat(process.env.MAX_CHECK_BUDGET_USDC || '0.05'),
    maxSessionBudgetUsdc: Number.parseFloat(process.env.MAX_SESSION_BUDGET_USDC || '0.50'),
    port: Number.parseInt(process.env.PORT || '8787', 10),
    estimatedUnitPriceUsdc: 0.01,
    requestTimeoutMs: Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '45000', 10),
    settleVerifyTimeoutMs: Number.parseInt(process.env.SETTLE_VERIFY_TIMEOUT_MS || '45000', 10),
    evidenceDir: path.join(ROOT_DIR, 'evidence'),
  };
}
