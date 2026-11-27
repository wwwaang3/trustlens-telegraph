import { ethers } from 'ethers';
import { BASE_SEPOLIA } from './config.js';

const ERC20_TRANSFER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
];

/**
 * Decode a base64-encoded x402 v2 `Payment-Required` header.
 */
export function decodePaymentRequired(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    throw new Error('Missing Payment-Required header in HTTP 402 response');
  }
  const jsonText = Buffer.from(headerValue, 'base64').toString('utf8');
  const parsed = JSON.parse(jsonText);
  if (!parsed || !Array.isArray(parsed.accepts) || parsed.accepts.length === 0) {
    throw new Error('Invalid x402 challenge: accepts[] is missing or empty');
  }
  return parsed;
}

/**
 * Pick the exact EVM option matching the configured chainId from `accepts[]`.
 */
export function selectEvmAccept(challenge, chainId) {
  const expectedNetwork = `eip155:${chainId}`;
  const exact = challenge.accepts.find(
    (a) => a.scheme === 'exact' && a.network === expectedNetwork,
  );
  if (exact) return exact;

  const anyEvm = challenge.accepts.find((a) => a.scheme === 'exact' && String(a.network).startsWith('eip155:'));
  if (!anyEvm) {
    throw new Error(`No exact EVM payment option found in x402 challenge (expected ${expectedNetwork})`);
  }
  const actualChainId = Number.parseInt(String(anyEvm.network).split(':')[1], 10);
  if (actualChainId !== chainId) {
    throw new Error(`x402 challenge network ${anyEvm.network} does not match configured chainId ${chainId}`);
  }
  return anyEvm;
}

/**
 * Format 6-decimal USDC base units into a numeric USD amount.
 */
export function usdcUnitsToUsd(units) {
  return Number(BigInt(units)) / 1_000_000;
}

/**
 * Sign an x402 v2 EIP-3009 TransferWithAuthorization (gasless for payer).
 * Always reads domain name/version and payTo from the server's 402 challenge.
 * Enforces `maxAllowedUsdc` strictly BEFORE signing.
 */
export async function signX402Payment({ challenge, wallet, chainId, maxAllowedUsdc }) {
  const accept = selectEvmAccept(challenge, chainId);
  const priceUsd = usdcUnitsToUsd(accept.amount);

  if (typeof maxAllowedUsdc === 'number' && priceUsd > maxAllowedUsdc + 1e-12) {
    const err = new Error(
      `Budget guard refused payment: x402 quote $${priceUsd.toFixed(4)} USDC exceeds remaining cap $${maxAllowedUsdc.toFixed(4)} USDC`,
    );
    err.code = 'BUDGET_EXCEEDED';
    err.quoteUsd = priceUsd;
    err.capUsd = maxAllowedUsdc;
    throw err;
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: ethers.getAddress(wallet.address),
    to: ethers.getAddress(accept.payTo),
    value: String(accept.amount),
    validAfter: String(now - 30),
    validBefore: String(now + Math.max(Number(accept.maxTimeoutSeconds || 60), 300)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  const domain = {
    name: accept.extra?.name || 'USDC',
    version: accept.extra?.version || '2',
    chainId,
    verifyingContract: ethers.getAddress(accept.asset),
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  });

  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: accept.network,
    accepted: accept,
    payload: { signature, authorization },
    extensions: {},
  };

  return {
    header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    authorization,
    accept,
    priceUsd,
    domain,
  };
}

/**
 * Decode x-payment-settle-response header if present.
 */
export function parseSettleHeader(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
}

/**
 * Query Base Sepolia RPC for the agent's Circle USDC balance (for x402).
 */
export async function getX402UsdcBalance(address, rpcUrl, chainId) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const token = new ethers.Contract(BASE_SEPOLIA.usdcX402, ERC20_TRANSFER_ABI, provider);
  const raw = await token.balanceOf(ethers.getAddress(address));
  return {
    raw: raw.toString(),
    usd: usdcUnitsToUsd(raw),
  };
}

/**
 * Verify on Base Sepolia that the exact EIP-3009 authorization nonce settled on-chain.
 * Matches on unique nonce rather than amount so concurrent $0.01 calls are never confused.
 */
export async function verifySettlementOnChain({
  tokenAddress,
  authorizer,
  nonce,
  payTo,
  startBlock,
  rpcUrl,
  chainId,
  timeoutMs = 45000,
  intervalMs = 4000,
}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const contract = new ethers.Contract(ethers.getAddress(tokenAddress), ERC20_TRANSFER_ABI, provider);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const tip = await provider.getBlockNumber();
      const fromBlock = Math.max(0, startBlock);
      const authLogs = await contract.queryFilter(
        contract.filters.AuthorizationUsed(ethers.getAddress(authorizer), nonce),
        fromBlock,
        tip,
      );
      if (authLogs.length > 0) {
        const hit = authLogs[0];
        const xfers = await contract.queryFilter(
          contract.filters.Transfer(ethers.getAddress(authorizer), ethers.getAddress(payTo)),
          hit.blockNumber,
          hit.blockNumber,
        );
        const match = xfers.find((x) => x.transactionHash === hit.transactionHash);
        return {
          verified: true,
          txHash: hit.transactionHash,
          blockNumber: hit.blockNumber,
          valueUnits: match?.args?.[2]?.toString() ?? null,
          explorerUrl: `${BASE_SEPOLIA.basescanUrl}/tx/${hit.transactionHash}`,
        };
      }
    } catch {
      // Public testnet RPCs occasionally rate-limit getLogs; retry until deadline.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    verified: false,
    txHash: null,
    blockNumber: null,
    valueUnits: null,
    explorerUrl: null,
    note: `Settlement event not observed within ${Math.round(timeoutMs / 1000)}s (facilitator may still settle asynchronously).`,
  };
}
