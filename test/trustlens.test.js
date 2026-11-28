import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ethers } from 'ethers';
import { TrustLensEngine } from '../src/engine.js';
import { MISSION07_PRESETS } from '../src/fixtures.js';
import { planVerificationSteps } from '../src/planner.js';
import { computeReceiptHash, formatReceiptMarkdown } from '../src/receipts.js';
import { createTrustLensServer } from '../src/server.js';
import { normalizeProviderSignal } from '../src/verdict.js';
import { decodePaymentRequired, signX402Payment } from '../src/x402.js';

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlens-test-'));
  return path.join(dir, 'ledger.jsonl');
}

test('planner selects minimal relevant Mission 07 intents and respects budget cap', () => {
  const plan = planVerificationSteps(
    {
      claim: 'Test claim',
      url: 'https://example.com',
      productCode: '5449000000996',
      maxBudgetUsdc: 0.02,
    },
    { unitPriceUsdc: 0.01 },
  );

  assert.equal(plan.allowed, true);
  assert.equal(plan.requestedSteps.length, 3);
  assert.equal(plan.approvedSteps.length, 2);
  assert.equal(plan.trimmedSteps.length, 1);
  assert.equal(plan.approvedSteps[0].canonicalIntent, 'URL_SAFE_GENERAL');
  assert.equal(plan.approvedSteps[1].canonicalIntent, 'FACT_CHECK_GENERAL');
  assert.equal(plan.estimatedTotalUsdc, 0.02);
});

test('planner refuses check before payment when spending cap is below $0.01', () => {
  const plan = planVerificationSteps(
    { claim: 'Is this legit?', maxBudgetUsdc: 0.005 },
    { unitPriceUsdc: 0.01 },
  );
  assert.equal(plan.allowed, false);
  assert.equal(plan.approvedSteps.length, 0);
  assert.match(plan.blockedReason, /No x402 authorization was signed/);
});

test('planner throws INVALID_INPUT when all input fields are empty', () => {
  assert.throws(
    () => planVerificationSteps({ claim: '   ', url: '' }),
    (err) => err.code === 'INVALID_INPUT',
  );
});

test('x402 signer produces valid EIP-712 EIP-3009 TransferWithAuthorization and enforces maxAllowedUsdc', async () => {
  const wallet = ethers.Wallet.createRandom();
  const challengeObj = {
    x402Version: 2,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '10000',
        payTo: '0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e',
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
  const headerB64 = Buffer.from(JSON.stringify(challengeObj)).toString('base64');
  const decoded = decodePaymentRequired(headerB64);

  // Refuses when cap < $0.01
  await assert.rejects(
    () => signX402Payment({ challenge: decoded, wallet, chainId: 84532, maxAllowedUsdc: 0.005 }),
    (err) => err.code === 'BUDGET_EXCEEDED',
  );

  // Signs cleanly when cap >= $0.01 and signature recovers exact payer
  const signed = await signX402Payment({
    challenge: decoded,
    wallet,
    chainId: 84532,
    maxAllowedUsdc: 0.01,
  });
  assert.equal(signed.priceUsd, 0.01);
  const decodedSig = JSON.parse(Buffer.from(signed.header, 'base64').toString('utf8'));
  assert.equal(decodedSig.x402Version, 2);
  assert.equal(decodedSig.payload.authorization.from, wallet.address);

  const recovered = ethers.verifyTypedData(
    signed.domain,
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    {
      ...decodedSig.payload.authorization,
      value: BigInt(decodedSig.payload.authorization.value),
      validAfter: BigInt(decodedSig.payload.authorization.validAfter),
      validBefore: BigInt(decodedSig.payload.authorization.validBefore),
    },
    decodedSig.payload.signature,
  );
  assert.equal(recovered, wallet.address);
});

test('verdict normalizer refuses forced binary judgment on low-confidence or uncheckable claims', () => {
  const lowConf = normalizeProviderSignal(
    { id: 'fact-check' },
    { verdict: 'True', confidence: 0.52, summary: 'Weak match' },
  );
  assert.equal(lowConf.signal, 'UNKNOWN');

  const privateClaim = normalizeProviderSignal(
    { id: 'fact-check' },
    { verdict: 'True', confidence: 0.9, summary: 'Claim looks plausible' },
    { uncheckableMarkers: ['private telegram group'] },
  );
  assert.equal(privateClaim.signal, 'UNKNOWN');

  // Negated threat phrases in benign URL summaries must NOT trigger false SUSPICIOUS
  const benignProse = normalizeProviderSignal(
    { id: 'url-safe' },
    'The URL example.com is clean and not listed on any phishing or malware blocklist.',
  );
  assert.equal(benignProse.signal, 'SUPPORTED');

  // Internal contradiction between boolean and status must abstain to UNKNOWN
  const contradictoryFields = normalizeProviderSignal(
    { id: 'url-safe' },
    { is_malicious: false, status: 'suspicious', confidence: 0.88, summary: 'Conflicting feed output' },
  );
  assert.equal(contradictoryFields.signal, 'UNKNOWN');

  // Live Telegraph Escrow findings.items response normalizes cleanly
  const liveFindingsShape = normalizeProviderSignal(
    { id: 'url-safe' },
    {
      result: { safe: true },
      findings: {
        items: [
          {
            name: 'answer',
            value:
              'The URL https://example.com is assessed as safe with no phishing, malware, or scam indicators detected.',
          },
          { name: 'verdict', value: 'safe' },
        ],
      },
    },
  );
  assert.equal(liveFindingsShape.signal, 'SUPPORTED');
  assert.match(liveFindingsShape.summary, /assessed as safe/);
});

test('all 6 Mission 07 presets match expected tri-state verdicts & produce verifiable SHA-256 receipts', async () => {
  const ledgerPath = tmpLedger();
  const engine = new TrustLensEngine({ ledgerPath });

  for (const preset of Object.values(MISSION07_PRESETS)) {
    const receipt = await engine.verify(
      { ...preset.input, presetId: preset.id },
      { mode: 'fixture', recordLedger: true },
    );
    assert.equal(
      receipt.verdict,
      preset.expectedVerdict,
      `Preset ${preset.id} verdict mismatch: got ${receipt.verdict}, expected ${preset.expectedVerdict}`,
    );
    assert.equal(receipt.isLivePayment, false);

    // Recompute digest to guarantee tamper-evidence
    const { receiptHash, ...core } = receipt;
    assert.equal(computeReceiptHash(core), receiptHash);

    const md = formatReceiptMarkdown(receipt);
    assert.match(md, /OFFLINE FIXTURE REPLAY/);
  }

  const summary = engine.getLedgerSummary();
  assert.equal(summary.totalChecks, 6);
  assert.equal(summary.verdicts.VERIFIED, 1);
  assert.equal(summary.verdicts.SUSPICIOUS, 1);
  assert.equal(summary.verdicts.UNKNOWN, 4);
  assert.equal(summary.budgetBlocks, 1);
});

test('failure case: simulated paid live mode handles upstream error by failing closed to UNKNOWN', async () => {
  const fakeClient = {
    payerAddress: '0x1111111111111111111111111111111111111111',
    canPayLive: true,
    activePaymentRail: 'x402',
    async askPaid() {
      const err = new Error('Simulated 502 Bad Gateway');
      err.code = 'UPSTREAM_HTTP_ERROR';
      err.httpStatus = 502;
      throw err;
    },
  };
  const engine = new TrustLensEngine({ client: fakeClient, ledgerPath: tmpLedger() });
  const receipt = await engine.verify(
    { claim: 'Test live failure handling', maxBudgetUsdc: 0.05 },
    { mode: 'live', recordLedger: true },
  );

  assert.equal(receipt.verdict, 'UNKNOWN');
  assert.equal(receipt.action, 'ABSTAIN_HUMAN_REVIEW_REQUIRED');
  assert.equal(receipt.accounting.totalCostUsd, 0);
  assert.equal(receipt.checks[0].error.code, 'UPSTREAM_HTTP_ERROR');
});

test('HTTP server exposes /api/status, /api/presets, /api/verify, and static UI cleanly', async () => {
  const { server } = createTrustLensServer({ ledgerPath: tmpLedger() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /TrustLens/);

    const presetsRes = await fetch(`${base}/api/presets`);
    assert.equal(presetsRes.status, 200);
    const presetsJson = await presetsRes.json();
    assert.equal(presetsJson.presets.length, 6);

    const verifyRes = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...MISSION07_PRESETS['conflicting-evidence'].input,
        presetId: 'conflicting-evidence',
        mode: 'fixture',
      }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyJson = await verifyRes.json();
    assert.equal(verifyJson.receipt.verdict, 'UNKNOWN');
    assert.equal(verifyJson.receipt.action, 'ABSTAIN_CONFLICTING_EVIDENCE');
    assert.equal(verifyJson.receipt.contradictions.length, 1);

    const badRes = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: '', mode: 'fixture' }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.close();
  }
});
