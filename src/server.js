import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, ROOT_DIR } from './config.js';
import { TrustLensEngine } from './engine.js';
import { listPresets } from './fixtures.js';
import { formatReceiptMarkdown } from './receipts.js';
import { getX402UsdcBalance } from './x402.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) {
      throw new Error('Request body exceeds 256KB limit');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export function createTrustLensServer(engineOverrides = {}) {
  const engine = new TrustLensEngine(engineOverrides);
  const cfg = engine.config;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Health & live node status
      if (req.method === 'GET' && pathname === '/api/status') {
        const status = {
          app: 'TrustLens',
          mission: 'Mission 07 — Consumer Platform (Season II)',
          nodeUrl: cfg.nodeUrl,
          backendUrl: cfg.backendUrl,
          chainId: cfg.chainId,
          activePaymentRail: engine.client.activePaymentRail,
          canPayLive: engine.client.canPayLive,
          escrowConfigured: engine.client.hasEscrowKey,
          walletConfigured: Boolean(engine.client.payerAddress),
          payerAddress: engine.client.payerAddress,
          escrowBalance: null,
          walletUsdcBalance: null,
          maxCheckBudgetUsdc: cfg.maxCheckBudgetUsdc,
          maxSessionBudgetUsdc: cfg.maxSessionBudgetUsdc,
          remainingSessionBudgetUsdc: engine.remainingSessionBudgetUsdc,
          ledger: engine.getLedgerSummary(),
        };

        if (engine.client.hasEscrowKey && url.searchParams.get('balance') === '1') {
          try {
            status.escrowBalance = await engine.client.getEscrowBalance();
          } catch (e) {
            status.escrowBalance = { error: String(e.message || e) };
          }
        }
        if (engine.client.payerAddress && url.searchParams.get('balance') === '1') {
          try {
            status.walletUsdcBalance = await getX402UsdcBalance(
              engine.client.payerAddress,
              cfg.rpcUrl,
              cfg.chainId,
            );
          } catch (e) {
            status.walletUsdcBalance = { error: String(e.message || e) };
          }
        }
        return sendJson(res, 200, status);
      }

      // Live Telegraph devnode probe (intents + real 402 quote)
      if (req.method === 'GET' && pathname === '/api/telegraph/live') {
        const [intentsData, probe] = await Promise.all([
          engine.client.getLiveIntents(),
          engine.client.probeAsk('Fact-check: Water boils at 100 degrees Celsius at 1 atm.'),
        ]);
        const targetIds = [
          'FACT_CHECK_GENERAL',
          'URL_SAFE_GENERAL',
          'AI_TEXT_DETECTION_GENERAL',
          'CONTENT_VERIFICATION_GENERAL',
          'MEDIA_FORENSIC_VERIFY_GENERAL',
          'PRODUCT_AUTHENTICITY_GENERAL',
          'WEB_SEARCH_GENERAL',
          'FRAUD_DETECTION_GENERAL',
        ];
        const mission07Intents = targetIds.map((id) => {
          const hit = (intentsData.intents || []).find((x) => x.intent_id === id);
          return {
            intent_id: id,
            miner_count: hit?.miner_count ?? 0,
            lifecycle_state: hit?.lifecycle_state ?? 'unknown',
            class: hit?.class ?? 'unknown',
          };
        });
        return sendJson(res, 200, {
          nodeUrl: cfg.nodeUrl,
          totalCanonicalIntents: intentsData.count ?? 0,
          mission07Intents,
          x402Probe: probe,
        });
      }

      // Presets list
      if (req.method === 'GET' && pathname === '/api/presets') {
        return sendJson(res, 200, { presets: listPresets() });
      }

      // Ledger metrics
      if (req.method === 'GET' && pathname === '/api/ledger') {
        return sendJson(res, 200, engine.getLedgerSummary());
      }

      // Main verification endpoint
      if (req.method === 'POST' && pathname === '/api/verify') {
        const body = await readJsonBody(req);
        const mode = ['live', 'probe', 'fixture'].includes(body.mode)
          ? body.mode
          : engine.client.canPayLive
            ? 'live'
            : 'probe';

        const receipt = await engine.verify(body, {
          mode,
          verifyOnChain: body.verifyOnChain !== false,
          recordLedger: body.recordLedger !== false,
        });
        return sendJson(res, 200, {
          receipt,
          markdown: formatReceiptMarkdown(receipt),
          remainingSessionBudgetUsdc: engine.remainingSessionBudgetUsdc,
        });
      }

      // Static files from public/
      if (req.method === 'GET') {
        const safeRel = pathname === '/' ? '/index.html' : pathname;
        const resolved = path.resolve(PUBLIC_DIR, '.' + safeRel);
        if (!resolved.startsWith(PUBLIC_DIR) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        const ext = path.extname(resolved);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }

      return sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      const code = err?.code === 'INVALID_INPUT' ? 400 : 500;
      return sendJson(res, code, {
        error: String(err?.message || err),
        code: err?.code || 'INTERNAL_ERROR',
      });
    }
  });

  return { server, engine };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const cfg = getConfig();
  const { server, engine } = createTrustLensServer();
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\nTrustLens running at http://127.0.0.1:${cfg.port}`);
    console.log(`Telegraph Node: ${cfg.nodeUrl} | Escrow Backend: ${cfg.backendUrl}`);
    console.log(
      `Live Payment Rail: ${engine.client.activePaymentRail !== 'none' ? engine.client.activePaymentRail.toUpperCase() + ' ENABLED' : 'PROBE / OFFLINE FIXTURE (set ANJOMAN_API_KEY or AGENT_PRIVATE_KEY in .env)'}\n`,
    );
  });
}
