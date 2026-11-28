import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute deterministic SHA-256 hash of a receipt payload (excluding the hash field itself).
 */
export function computeReceiptHash(receiptCore) {
  const canonical = JSON.stringify(receiptCore);
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build a public-ready, tamper-evident Claim Receipt.
 */
export function buildReceipt({
  runId,
  timestamp,
  mode,
  networkLabel,
  nodeUrl,
  input,
  plan,
  stepResults,
  outcome,
  totalCostUsd,
  totalLatencyMs,
}) {
  const core = {
    schema: 'trustlens.mission07.receipt.v1',
    mission: 'Mission 07 — Consumer Platform (Season II)',
    runId,
    timestamp,
    executionMode: mode, // 'live' | 'probe' | 'fixture'
    isLivePayment:
      mode === 'live' &&
      stepResults.some((s) => Boolean(s.payment?.nonce || s.payment?.receiptHash)),
    network: networkLabel,
    nodeUrl,
    input: {
      claim: input.claim || null,
      url: input.url || null,
      productCode: input.productCode || null,
      hasTextSample: Boolean(input.textSample),
      mediaUrl: input.mediaUrl || null,
      maxBudgetUsdc: plan.effectiveCapUsdc,
    },
    verdict: outcome.verdict,
    action: outcome.action,
    confidence: outcome.confidence,
    headline: outcome.headline,
    explanation: outcome.explanation,
    contradictions: outcome.contradictions,
    uncertaintyFactors: outcome.uncertaintyFactors,
    accounting: {
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      currency: 'USDC',
      stepsPlanned: plan.requestedSteps.length,
      stepsExecuted: stepResults.length,
      stepsSkippedByCap: plan.trimmedSteps.length,
      totalLatencyMs,
    },
    checks: stepResults.map((s) => ({
      stepId: s.id,
      targetFamily: s.targetFamily,
      requestedIntent: s.canonicalIntent,
      routedIntent: s.routedIntent || null,
      minerId: s.minerId ?? null,
      minerName: s.minerName || null,
      servedRank: s.servedRank ?? null,
      signalHash: s.signalHash || null,
      latencyMs: s.latencyMs,
      costUsd: s.costUsd,
      signal: s.normalized.signal,
      confidence: s.normalized.confidence,
      summary: s.normalized.summary,
      uncertainty: s.normalized.uncertainty,
      payment: s.payment || null,
      settlement: s.settlement || null,
      probe: s.probe || null,
      error: s.error || null,
    })),
  };

  const receiptHash = computeReceiptHash(core);
  return { ...core, receiptHash };
}

/**
 * Render a clean copyable Markdown summary for social/moderation queues or GitHub evidence.
 */
export function formatReceiptMarkdown(receipt) {
  const modeTag =
    receipt.executionMode === 'live'
      ? `LIVE TELEGRAPH TESTNET (${receipt.network})`
      : receipt.executionMode === 'probe'
        ? `LIVE 402 PROBE — NO PAYMENT SIGNED (${receipt.network})`
        : 'OFFLINE FIXTURE REPLAY (NOT A LIVE PAYMENT)';

  const lines = [
    `### TrustLens Claim Receipt — \`${receipt.verdict}\` (${Math.round(receipt.confidence * 100)}%)`,
    `- **Action:** \`${receipt.action}\``,
    `- **Mode:** ${modeTag}`,
    `- **Total Cost:** \`$${receipt.accounting.totalCostUsd.toFixed(4)} USDC\` across ${receipt.accounting.stepsExecuted} check(s) (${receipt.accounting.totalLatencyMs} ms)`,
    `- **Summary:** ${receipt.explanation}`,
    `- **Receipt Digest:** \`${receipt.receiptHash}\``,
    '',
    '| Check | Routed Intent | Miner | Signal | Cost (USDC) | Provenance / Settlement |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const c of receipt.checks) {
    const prov = c.settlement?.explorerUrl
      ? `[Basescan TX](${c.settlement.explorerUrl})`
      : c.payment?.receiptHash
        ? `Escrow receipt \`${String(c.payment.receiptHash).slice(0, 14)}…\` (epoch ${c.payment.epochId ?? '?'})`
        : c.signalHash
          ? `\`${String(c.signalHash).slice(0, 18)}...\``
          : c.probe?.payTo
            ? `402 quote -> \`${c.probe.payTo.slice(0, 10)}...\``
            : c.error
              ? `Error: ${c.error.code}`
              : '—';
    lines.push(
      `| ${c.stepId} | \`${c.routedIntent || c.requestedIntent}\` | ${c.minerName ? `${c.minerName} (#${c.minerId})` : '—'} | **${c.signal}** | $${Number(c.costUsd || 0).toFixed(4)} | ${prov} |`,
    );
  }

  if (receipt.uncertaintyFactors.length > 0) {
    lines.push('', '**Uncertainty / Guardrail Notes:**');
    for (const u of receipt.uncertaintyFactors) {
      lines.push(`- ${u}`);
    }
  }

  return lines.join('\n');
}

/**
 * Append receipt to JSONL accounting ledger on disk.
 */
export function appendLedger(ledgerPath, receipt) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(receipt) + '\n', 'utf8');
}

/**
 * Read receipts from JSONL ledger and compute operational Mission 07 metrics.
 */
export function readLedgerSummary(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) {
    return {
      totalChecks: 0,
      liveChecks: 0,
      probeChecks: 0,
      fixtureChecks: 0,
      totalCostUsd: 0,
      avgCostPerCheckUsd: 0,
      verdicts: { VERIFIED: 0, SUSPICIOUS: 0, UNKNOWN: 0 },
      budgetBlocks: 0,
      recent: [],
    };
  }

  const lines = fs
    .readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const receipts = [];
  for (const line of lines) {
    try {
      receipts.push(JSON.parse(line));
    } catch {
      // Ignore partial lines
    }
  }

  const verdicts = { VERIFIED: 0, SUSPICIOUS: 0, UNKNOWN: 0 };
  let liveChecks = 0;
  let probeChecks = 0;
  let fixtureChecks = 0;
  let totalCostUsd = 0;
  let budgetBlocks = 0;

  for (const r of receipts) {
    if (verdicts[r.verdict] !== undefined) verdicts[r.verdict] += 1;
    if (r.executionMode === 'live') liveChecks += 1;
    else if (r.executionMode === 'probe') probeChecks += 1;
    else fixtureChecks += 1;
    totalCostUsd += Number(r.accounting?.totalCostUsd || 0);
    if (r.action === 'BLOCKED_BY_BUDGET_GUARD') budgetBlocks += 1;
  }

  return {
    totalChecks: receipts.length,
    liveChecks,
    probeChecks,
    fixtureChecks,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    avgCostPerCheckUsd: receipts.length > 0 ? Number((totalCostUsd / receipts.length).toFixed(6)) : 0,
    verdicts,
    budgetBlocks,
    recent: receipts.slice(-15).reverse(),
  };
}
