import crypto from 'node:crypto';
import path from 'node:path';
import { getConfig } from './config.js';
import { MISSION07_PRESETS } from './fixtures.js';
import { planVerificationSteps } from './planner.js';
import { appendLedger, buildReceipt, readLedgerSummary } from './receipts.js';
import { TelegraphClient } from './telegraph.js';
import { aggregateVerdict, normalizeProviderSignal } from './verdict.js';

export class TrustLensEngine {
  constructor(overrides = {}) {
    this.config = { ...getConfig(), ...overrides };
    this.client = overrides.client || new TelegraphClient(this.config);
    this.sessionSpentUsd = 0;
    this.ledgerPath =
      overrides.ledgerPath || path.join(this.config.evidenceDir, 'ledger.jsonl');
  }

  get remainingSessionBudgetUsdc() {
    return Math.max(0, Number((this.config.maxSessionBudgetUsdc - this.sessionSpentUsd).toFixed(6)));
  }

  /**
   * Run a complete Mission 07 verification workflow.
   *
   * @param {object} input - { claim, url, productCode, textSample, mediaUrl, maxBudgetUsdc, presetId, simulateUpstreamFailure }
   * @param {object} opts  - { mode: 'live' | 'probe' | 'fixture', verifyOnChain: boolean, recordLedger: boolean }
   */
  async verify(input, opts = {}) {
    const mode = opts.mode || (this.client.canPayLive ? 'live' : 'probe');
    const verifyOnChain = opts.verifyOnChain !== false;
    const recordLedger = opts.recordLedger !== false;

    const runId = `tl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const t0 = Date.now();

    const plan = planVerificationSteps(input, {
      unitPriceUsdc: this.config.estimatedUnitPriceUsdc,
      maxCheckBudgetUsdc: this.config.maxCheckBudgetUsdc,
      remainingSessionBudgetUsdc: this.remainingSessionBudgetUsdc,
    });

    const stepResults = [];
    let checkSpentUsd = 0;

    if (plan.allowed) {
      for (const step of plan.approvedSteps) {
        const stepT0 = Date.now();
        const remainingForCheck = Math.max(0, plan.effectiveCapUsdc - checkSpentUsd);

        // Explicit simulated upstream failure test path (for failure-case verification)
        if (input.simulateUpstreamFailure) {
          const err = {
            code: 'UPSTREAM_503_SIMULATED',
            message: 'Simulated Telegraph provider 503 Service Unavailable / timeout (no x402 payment executed).',
          };
          const normalized = normalizeProviderSignal(step, null, {
            error: err,
            uncheckableMarkers: plan.artifacts.uncheckableMarkers,
          });
          stepResults.push({
            ...step,
            routedIntent: step.canonicalIntent,
            minerId: null,
            minerName: null,
            signalHash: null,
            latencyMs: Date.now() - stepT0,
            costUsd: 0,
            rawResult: null,
            normalized,
            payment: null,
            settlement: null,
            probe: null,
            error: err,
          });
          continue;
        }

        if (mode === 'fixture') {
          const preset = input.presetId ? MISSION07_PRESETS[input.presetId] : null;
          const fixture = preset?.fixtureResponses?.[step.id] || {
            miner_id: 41008,
            miner_name: 'Fixture Generic Verifier (Offline Replay)',
            intent: step.canonicalIntent,
            cost_usd: 0.01,
            signal_hash: `fixture-${step.id}-${crypto.randomBytes(3).toString('hex')}`,
            result: {
              verdict: 'Insufficient Evidence',
              confidence: 0.4,
              summary: 'Offline fixture replay without custom preset mapping; abstaining to UNKNOWN.',
            },
          };

          const normalized = normalizeProviderSignal(step, fixture.result, {
            uncheckableMarkers: plan.artifacts.uncheckableMarkers,
          });
          const simCost = Number(fixture.cost_usd || 0.01);
          checkSpentUsd += simCost;
          stepResults.push({
            ...step,
            routedIntent: fixture.intent,
            minerId: fixture.miner_id,
            minerName: fixture.miner_name,
            signalHash: fixture.signal_hash,
            latencyMs: Date.now() - stepT0,
            costUsd: simCost,
            rawResult: fixture.result,
            normalized,
            payment: {
              protocol: 'offline-fixture-replay',
              note: 'NOT a live on-chain payment. Switch to live mode with Base Sepolia Circle USDC to settle via x402.',
              priceUsd: simCost,
            },
            settlement: null,
            probe: null,
            error: null,
          });
          continue;
        }

        if (mode === 'probe') {
          try {
            const probe = await this.client.probeAsk(step.query);
            const normalized = normalizeProviderSignal(step, null, {
              error: {
                code: 'LIVE_402_DRY_PROBE',
                message: probe.x402Required
                  ? `Live Telegraph devnode challenged HTTP 402 ($${probe.quoteUsd.toFixed(4)} USDC on ${probe.network}, payTo ${probe.payTo}). Dry-probe mode did not sign payment.`
                  : `Live node returned HTTP ${probe.status}.`,
              },
              uncheckableMarkers: plan.artifacts.uncheckableMarkers,
            });
            stepResults.push({
              ...step,
              routedIntent: step.canonicalIntent,
              minerId: null,
              minerName: null,
              signalHash: null,
              latencyMs: probe.latencyMs,
              costUsd: 0,
              rawResult: null,
              normalized,
              payment: null,
              settlement: null,
              probe,
              error: null,
            });
          } catch (e) {
            const err = { code: e.code || 'PROBE_NETWORK_ERROR', message: String(e.message || e) };
            stepResults.push({
              ...step,
              routedIntent: step.canonicalIntent,
              minerId: null,
              minerName: null,
              signalHash: null,
              latencyMs: Date.now() - stepT0,
              costUsd: 0,
              rawResult: null,
              normalized: normalizeProviderSignal(step, null, { error: err }),
              payment: null,
              settlement: null,
              probe: null,
              error: err,
            });
          }
          continue;
        }

        // LIVE MODE: real paid Telegraph call (Telegraph Escrow API or Base Sepolia x402 v2)
        try {
          const paidRes = await this.client.askPaid({
            query: step.query,
            maxAllowedUsdc: remainingForCheck,
            verifyOnChain,
          });

          const body = paidRes.responseBody || {};
          const rawResult = body.findings ? body : (body.result ?? body);
          const normalized = normalizeProviderSignal(step, rawResult, {
            uncheckableMarkers: plan.artifacts.uncheckableMarkers,
          });

          checkSpentUsd += paidRes.costUsd;
          this.sessionSpentUsd += paidRes.costUsd;

          stepResults.push({
            ...step,
            routedIntent: body.intent || step.canonicalIntent,
            minerId: body.miner_id ?? null,
            minerName: body.miner_name || null,
            servedRank: body.served_rank ?? null,
            signalHash: body.signal_hash || null,
            latencyMs: paidRes.latencyMs,
            costUsd: paidRes.costUsd,
            rawResult,
            normalized,
            payment: paidRes.payment,
            settlement: paidRes.settlement,
            probe: null,
            error: null,
          });
        } catch (e) {
          const err = {
            code: e.code || 'TELEGRAPH_CALL_FAILED',
            message: String(e.message || e),
            httpStatus: e.httpStatus ?? null,
          };
          const normalized = normalizeProviderSignal(step, null, {
            error: err,
            uncheckableMarkers: plan.artifacts.uncheckableMarkers,
          });
          stepResults.push({
            ...step,
            routedIntent: step.canonicalIntent,
            minerId: null,
            minerName: null,
            signalHash: null,
            latencyMs: Date.now() - stepT0,
            costUsd: 0,
            rawResult: null,
            normalized,
            payment: e.payment || null,
            settlement: e.settleHeader ? { header: e.settleHeader, onChain: null, txHash: null } : null,
            probe: null,
            error: err,
          });
        }
      }
    }

    const outcome = aggregateVerdict({ stepResults, plan });
    const railUsed = this.client.activePaymentRail;
    const networkLabel =
      mode === 'fixture'
        ? 'offline-fixture-replay'
        : mode === 'live' && railUsed === 'escrow'
          ? 'telegraph-escrow (sepolia-testnet)'
          : `base-sepolia (eip155:${this.config.chainId})`;

    const receipt = buildReceipt({
      runId,
      timestamp,
      mode,
      networkLabel,
      nodeUrl: mode === 'live' && railUsed === 'escrow' ? this.config.backendUrl : this.config.nodeUrl,
      input,
      plan,
      stepResults,
      outcome,
      totalCostUsd: mode === 'live' ? checkSpentUsd : mode === 'fixture' ? checkSpentUsd : 0,
      totalLatencyMs: Date.now() - t0,
    });

    if (recordLedger) {
      appendLedger(this.ledgerPath, receipt);
    }

    return receipt;
  }

  getLedgerSummary() {
    return readLedgerSummary(this.ledgerPath);
  }
}
