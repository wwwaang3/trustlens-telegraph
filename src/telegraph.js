import { ethers } from 'ethers';
import {
  decodePaymentRequired,
  parseSettleHeader,
  selectEvmAccept,
  signX402Payment,
  usdcUnitsToUsd,
  verifySettlementOnChain,
} from './x402.js';

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class TelegraphClient {
  constructor(config) {
    this.config = config;
    this.wallet = config.agentPrivateKey ? new ethers.Wallet(config.agentPrivateKey) : null;
    this.apiKey = config.anjomanApiKey || '';
  }

  get payerAddress() {
    return this.wallet ? this.wallet.address : null;
  }

  get hasEscrowKey() {
    return Boolean(this.apiKey);
  }

  get activePaymentRail() {
    if (this.config.preferredRail === 'x402' && this.wallet) return 'x402';
    if (this.config.preferredRail === 'escrow' && this.apiKey) return 'escrow';
    if (this.apiKey) return 'escrow';
    if (this.wallet) return 'x402';
    return 'none';
  }

  get canPayLive() {
    return this.activePaymentRail !== 'none';
  }

  /** Fetch live canonical intents and active miner counts from devnode. */
  async getLiveIntents() {
    const res = await fetchWithTimeout(
      `${this.config.engineUrl}/v1/intents`,
      { headers: { Accept: 'application/json' } },
      this.config.requestTimeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Telegraph /engine/v1/intents returned HTTP ${res.status}`);
    }
    return res.json();
  }

  /** Fetch live routable miners from /engine/v1/subnets. */
  async getLiveSubnets() {
    const res = await fetchWithTimeout(
      `${this.config.engineUrl}/v1/subnets`,
      { headers: { Accept: 'application/json' } },
      this.config.requestTimeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Telegraph /engine/v1/subnets returned HTTP ${res.status}`);
    }
    return res.json();
  }

  /** Fetch live Telegraph Escrow balance when ANJOMAN_API_KEY is configured. */
  async getEscrowBalance() {
    if (!this.apiKey) return null;
    const res = await fetchWithTimeout(
      `${this.config.backendUrl}/engine/escrow/balance`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      },
      this.config.requestTimeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Telegraph /engine/escrow/balance returned HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Probe POST /engine/v1/ask without signing payment to inspect the live x402 v2
   * challenge, exact USDC quote, network, and payTo receiver.
   */
  async probeAsk(query) {
    const url = `${this.config.engineUrl}/v1/ask`;
    const t0 = Date.now();
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query }),
      },
      this.config.requestTimeoutMs,
    );
    const latencyMs = Date.now() - t0;

    if (res.status !== 402) {
      return {
        status: res.status,
        latencyMs,
        x402Required: false,
        body: await res.text(),
      };
    }

    const header = res.headers.get('Payment-Required') ?? res.headers.get('payment-required');
    const challenge = decodePaymentRequired(header);
    const evmAccept = selectEvmAccept(challenge, this.config.chainId);

    return {
      status: 402,
      latencyMs,
      x402Required: true,
      url,
      x402Version: challenge.x402Version,
      resourceDescription: challenge.resource?.description ?? null,
      quoteUsd: usdcUnitsToUsd(evmAccept.amount),
      quoteUnits: evmAccept.amount,
      network: evmAccept.network,
      asset: evmAccept.asset,
      payTo: evmAccept.payTo,
      acceptsCount: challenge.accepts.length,
    };
  }

  /**
   * Execute a paid Telegraph Engine ask via the official Telegraph Escrow rail
   * (`POST https://backend.telegraphprotocol.com/engine/ask` with `ANJOMAN_API_KEY`).
   */
  async askPaidEscrow({ query, maxAllowedUsdc }) {
    if (!this.apiKey) {
      const err = new Error('ANJOMAN_API_KEY is not configured for Telegraph Escrow rail.');
      err.code = 'NO_ESCROW_KEY';
      throw err;
    }

    if (maxAllowedUsdc !== undefined && maxAllowedUsdc < this.config.estimatedUnitPriceUsdc) {
      const err = new Error(
        `Remaining per-check cap ($${Number(maxAllowedUsdc).toFixed(4)}) is below minimum Telegraph ask cost ($${this.config.estimatedUnitPriceUsdc.toFixed(4)}).`,
      );
      err.code = 'BUDGET_EXCEEDED';
      throw err;
    }

    const url = `${this.config.backendUrl}/engine/ask`;
    const t0 = Date.now();
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query }),
      },
      this.config.requestTimeoutMs,
    );
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const bodyText = await res.text();
      const err = new Error(
        `Telegraph Escrow /engine/ask returned HTTP ${res.status}: ${bodyText.slice(0, 280)}`,
      );
      err.code = 'UPSTREAM_HTTP_ERROR';
      err.httpStatus = res.status;
      throw err;
    }

    const payload = await res.json();
    const nodeResult = payload.result || payload;
    const receipt = payload.receipt || null;
    const rawCost =
      nodeResult.cost_usd_total ??
      nodeResult.cost_usd ??
      (receipt?.amount_uusdc ? usdcUnitsToUsd(receipt.amount_uusdc) : 0.01);
    const costUsd = Number(rawCost || 0);

    return {
      paid: true,
      rail: 'escrow',
      latencyMs,
      costUsd,
      responseBody: nodeResult,
      payment: {
        protocol: 'telegraph-escrow-epoch',
        rail: receipt?.rail || 'escrow',
        receiptHash: receipt?.receipt_hash || nodeResult.payments?.[0]?.receipt_hash || null,
        payer: receipt?.payer || null,
        miner: receipt?.miner || nodeResult.miner_id || null,
        intent: receipt?.intent || nodeResult.intent || null,
        amountUnits: receipt?.amount_uusdc ? String(receipt.amount_uusdc) : String(Math.round(costUsd * 1e6)),
        priceUsd: costUsd,
        epochId: receipt?.epoch_id ?? null,
        settlementMode: receipt?.settlement || 'epoch',
        chain: receipt?.chain || 'telegraph',
        timestamp: receipt?.timestamp ?? null,
      },
      settlement: {
        header: null,
        onChain: null,
        txHash: null,
        receiptHash: receipt?.receipt_hash || nodeResult.payments?.[0]?.receipt_hash || null,
        epochId: receipt?.epoch_id ?? null,
        explorerUrl: null,
      },
    };
  }

  /**
   * Execute a paid Telegraph Engine ask via x402 v2 on Base Sepolia.
   * Enforces `maxAllowedUsdc` strictly BEFORE signing EIP-3009 authorization.
   */
  async askPaidX402({ query, maxAllowedUsdc, verifyOnChain = true }) {
    if (!this.wallet) {
      const err = new Error(
        'AGENT_PRIVATE_KEY is not configured. Add a funded Base Sepolia testnet key in .env to execute live x402 payments (or configure ANJOMAN_API_KEY for Escrow rail).',
      );
      err.code = 'NO_WALLET_CONFIGURED';
      throw err;
    }

    const url = `${this.config.engineUrl}/v1/ask`;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
    };

    const t0 = Date.now();
    let startBlock = null;
    if (verifyOnChain) {
      try {
        const provider = new ethers.JsonRpcProvider(this.config.rpcUrl, this.config.chainId, {
          staticNetwork: true,
        });
        startBlock = await provider.getBlockNumber();
      } catch {
        startBlock = null;
      }
    }

    const first = await fetchWithTimeout(url, init, this.config.requestTimeoutMs);

    if (first.status !== 402) {
      if (!first.ok) {
        const bodyText = await first.text();
        const err = new Error(`Telegraph node returned HTTP ${first.status}: ${bodyText.slice(0, 240)}`);
        err.code = 'UPSTREAM_HTTP_ERROR';
        err.httpStatus = first.status;
        throw err;
      }
      const body = await first.json();
      return {
        paid: false,
        rail: 'x402',
        latencyMs: Date.now() - t0,
        costUsd: Number(body.cost_usd || 0),
        responseBody: body,
        payment: null,
        settlement: null,
      };
    }

    const header = first.headers.get('Payment-Required') ?? first.headers.get('payment-required');
    const challenge = decodePaymentRequired(header);

    const signed = await signX402Payment({
      challenge,
      wallet: this.wallet,
      chainId: this.config.chainId,
      maxAllowedUsdc,
    });

    const retry = await fetchWithTimeout(
      url,
      {
        ...init,
        headers: {
          ...init.headers,
          'PAYMENT-SIGNATURE': signed.header,
        },
      },
      this.config.requestTimeoutMs,
    );

    const latencyMs = Date.now() - t0;
    const settleRaw =
      retry.headers.get('x-payment-settle-response') ??
      retry.headers.get('X-Payment-Settle-Response') ??
      null;
    const settleParsed = parseSettleHeader(settleRaw);

    if (!retry.ok) {
      const bodyText = await retry.text();
      const err = new Error(
        `Telegraph x402 paid retry failed with HTTP ${retry.status}: ${bodyText.slice(0, 280)}`,
      );
      err.code = 'PAID_REQUEST_FAILED';
      err.httpStatus = retry.status;
      err.payment = {
        protocol: 'x402-v2-eip3009',
        payer: signed.authorization.from,
        payTo: signed.authorization.to,
        nonce: signed.authorization.nonce,
        amountUnits: signed.authorization.value,
        priceUsd: signed.priceUsd,
        network: signed.accept.network,
        asset: signed.accept.asset,
      };
      err.settleHeader = settleParsed;
      throw err;
    }

    const body = await retry.json();

    let onChainVerification = null;
    if (verifyOnChain && startBlock !== null) {
      onChainVerification = await verifySettlementOnChain({
        tokenAddress: signed.accept.asset,
        authorizer: signed.authorization.from,
        nonce: signed.authorization.nonce,
        payTo: signed.authorization.to,
        startBlock,
        rpcUrl: this.config.rpcUrl,
        chainId: this.config.chainId,
        timeoutMs: this.config.settleVerifyTimeoutMs,
      });
    }

    const txHash =
      onChainVerification?.txHash ||
      settleParsed?.transaction ||
      settleParsed?.txHash ||
      settleParsed?.tx_hash ||
      null;

    return {
      paid: true,
      rail: 'x402',
      latencyMs,
      costUsd: signed.priceUsd,
      responseBody: body,
      payment: {
        protocol: 'x402-v2-eip3009',
        payer: signed.authorization.from,
        payTo: signed.authorization.to,
        nonce: signed.authorization.nonce,
        amountUnits: signed.authorization.value,
        priceUsd: signed.priceUsd,
        network: signed.accept.network,
        asset: signed.accept.asset,
      },
      settlement: {
        header: settleParsed,
        onChain: onChainVerification,
        txHash,
        explorerUrl: txHash ? `https://sepolia.basescan.org/tx/${txHash}` : null,
      },
    };
  }

  /**
   * Dispatch live paid request over the active Telegraph payment rail
   * (Escrow via ANJOMAN_API_KEY or direct Base Sepolia x402 via AGENT_PRIVATE_KEY).
   */
  async askPaid({ query, maxAllowedUsdc, verifyOnChain = true, rail = null }) {
    const selectedRail = rail || this.activePaymentRail;
    if (selectedRail === 'escrow') {
      return this.askPaidEscrow({ query, maxAllowedUsdc });
    }
    if (selectedRail === 'x402') {
      return this.askPaidX402({ query, maxAllowedUsdc, verifyOnChain });
    }
    const err = new Error(
      'No live Telegraph payment credential configured. Set ANJOMAN_API_KEY (Telegraph Escrow) or AGENT_PRIVATE_KEY (Base Sepolia x402) in .env, or use probe / fixture mode.',
    );
    err.code = 'NO_PAYMENT_RAIL_CONFIGURED';
    throw err;
  }
}
