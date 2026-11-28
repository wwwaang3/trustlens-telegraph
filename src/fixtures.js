/**
 * Mission 07 (Consumer Platform) Showcase & Regression Presets.
 *
 * Covers every test case explicitly requested in Mission 07 (#195):
 *   1. benign-control       — verifiable factual claim + benign URL -> VERIFIED
 *   2. scam-listing         — deceptive giveaway + phishing URL + AI spam copy -> SUSPICIOUS
 *   3. uncheckable-claim    — private/future unverifiable claim -> UNKNOWN (no forced binary!)
 *   4. conflicting-evidence — conflicting specialist signals -> UNKNOWN (surfaces disagreement!)
 *   5. failure-budget-cap   — spending limit below $0.01 -> BLOCKED_BY_BUDGET_GUARD ($0 spent)
 *   6. failure-upstream     — upstream node timeout / HTTP 503 -> fails closed to UNKNOWN
 */

export const MISSION07_PRESETS = {
  'benign-control': {
    id: 'benign-control',
    label: '1. Benign Control (Expected: VERIFIED)',
    description: 'Well-established public fact paired with a canonical benign domain.',
    expectedVerdict: 'VERIFIED',
    input: {
      claim: 'Water boils at 100 degrees Celsius at standard atmospheric pressure (1 atm).',
      url: 'https://example.com',
      maxBudgetUsdc: 0.05,
    },
    fixtureResponses: {
      'url-safe': {
        miner_id: 92011,
        miner_name: 'Fixture URL Threat Feed (Offline Replay)',
        intent: 'URL_SAFE_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-url-benign-001',
        result: {
          status: 'safe',
          is_malicious: false,
          confidence: 0.96,
          summary: 'example.com is an IANA reserved documentation domain; not listed on any phishing or malware blocklist.',
        },
      },
      'fact-check': {
        miner_id: 41008,
        miner_name: 'Fixture Public Fact Checker (Offline Replay)',
        intent: 'FACT_CHECK_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-fact-benign-001',
        result: {
          verdict: 'True',
          confidence: 0.98,
          summary: 'Corroborated: pure water boils at 100 C (212 F) at 101.325 kPa standard atmospheric pressure.',
        },
      },
    },
  },

  'scam-listing': {
    id: 'scam-listing',
    label: '2. Phishing & Scam Offer (Expected: SUSPICIOUS)',
    description: 'Marketplace giveaway bait with lookalike phishing URL and synthetic AI promo text.',
    expectedVerdict: 'SUSPICIOUS',
    input: {
      claim: 'Official Apple Support is giving away free iPhone 17 Pro units if you verify your wallet seed phrase today.',
      url: 'https://apple-support-wallet-claim.example.invalid/verify',
      textSample:
        'Congratulations valued winner! Act immediately within 15 minutes to claim your complimentary flagship device by connecting and verifying your recovery seed phrase on our secure verification portal now.',
      maxBudgetUsdc: 0.05,
    },
    fixtureResponses: {
      'url-safe': {
        miner_id: 92011,
        miner_name: 'Fixture URL Threat Feed (Offline Replay)',
        intent: 'URL_SAFE_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-url-scam-002',
        result: {
          status: 'malicious',
          is_malicious: true,
          confidence: 0.94,
          summary: 'Flagged as phishing / brand impersonation pattern asking for wallet verification.',
        },
      },
      'fact-check': {
        miner_id: 41008,
        miner_name: 'Fixture Public Fact Checker (Offline Replay)',
        intent: 'FACT_CHECK_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-fact-scam-002',
        result: {
          verdict: 'False',
          confidence: 0.95,
          summary: 'Refuted: Apple does not run wallet seed-phrase giveaways; classic credential harvesting scam.',
        },
      },
      'ai-text-detect': {
        miner_id: 61004,
        miner_name: 'Fixture AI Copy Detector (Offline Replay)',
        intent: 'AI_TEXT_DETECTION_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-aitext-scam-002',
        result: {
          label: 'ai-generated',
          confidence: 0.89,
          summary: 'High likelihood of synthetic template / AI-generated urgency spam copy.',
        },
      },
    },
  },

  'uncheckable-claim': {
    id: 'uncheckable-claim',
    label: '3. Uncheckable Private Claim (Expected: UNKNOWN)',
    description: 'Private/unpublished claim where forced True/False judgment would be dishonest.',
    expectedVerdict: 'UNKNOWN',
    input: {
      claim: 'An unnamed private Telegram group moderator promised an undisclosed partner listing will double token value by midnight.',
      maxBudgetUsdc: 0.05,
    },
    fixtureResponses: {
      'fact-check': {
        miner_id: 41008,
        miner_name: 'Fixture Public Fact Checker (Offline Replay)',
        intent: 'FACT_CHECK_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-fact-unknown-003',
        result: {
          verdict: 'Insufficient Evidence',
          confidence: 0.28,
          summary: 'Unverifiable: no public source exists for private chat promises or future price guarantees.',
        },
      },
    },
  },

  'conflicting-evidence': {
    id: 'conflicting-evidence',
    label: '4. Ambiguous / Conflicting Signals (Expected: UNKNOWN)',
    description: 'Domain itself is clean, while promotional claim is disputed/suspicious — surfaces contradiction.',
    expectedVerdict: 'UNKNOWN',
    input: {
      claim: 'Clinically proven overnight miracle supplement endorsed by major medical journals.',
      url: 'https://cdn-hosted-storefront.example.com/product/miracle-drop',
      maxBudgetUsdc: 0.05,
    },
    fixtureResponses: {
      'url-safe': {
        miner_id: 92011,
        miner_name: 'Fixture URL Threat Feed (Offline Replay)',
        intent: 'URL_SAFE_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-url-conflict-004',
        result: {
          status: 'safe',
          is_malicious: false,
          confidence: 0.88,
          summary: 'Hosted on clean mainstream CDN; no malware or phishing blocklist hits.',
        },
      },
      'fact-check': {
        miner_id: 41008,
        miner_name: 'Fixture Public Fact Checker (Offline Replay)',
        intent: 'FACT_CHECK_GENERAL',
        cost_usd: 0.01,
        signal_hash: 'fixture-fact-conflict-004',
        result: {
          verdict: 'False',
          confidence: 0.84,
          summary: 'No peer-reviewed clinical trial supports the overnight cure claim; misleading health marketing.',
        },
      },
    },
  },

  'failure-budget-cap': {
    id: 'failure-budget-cap',
    label: '5. Failure Case — Spending Cap Refusal (Expected: UNKNOWN / BLOCKED)',
    description: 'Per-check budget ($0.005) is below a single $0.01 Telegraph call; blocks BEFORE signing payment.',
    expectedVerdict: 'UNKNOWN',
    input: {
      claim: 'Check whether this marketplace seller invoice is genuine.',
      url: 'https://example.com/invoice/9912',
      maxBudgetUsdc: 0.005,
    },
    fixtureResponses: {},
  },

  'failure-upstream': {
    id: 'failure-upstream',
    label: '6. Failure Case — Upstream Miner Timeout / 503 (Expected: UNKNOWN)',
    description: 'Simulates an unreachable or failing Telegraph provider; fails closed to UNKNOWN with $0 paid.',
    expectedVerdict: 'UNKNOWN',
    input: {
      claim: 'Verify live authenticity of limited-edition sneaker listing #88412.',
      maxBudgetUsdc: 0.05,
      simulateUpstreamFailure: true,
    },
    fixtureResponses: {},
  },
};

export function listPresets() {
  return Object.values(MISSION07_PRESETS).map(({ id, label, description, expectedVerdict, input }) => ({
    id,
    label,
    description,
    expectedVerdict,
    input,
  }));
}
