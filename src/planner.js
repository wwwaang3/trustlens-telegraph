/**
 * Mission 07 (Consumer Platform) Intelligence Planner.
 *
 * Inspects a consumer post/claim/listing and selects ONLY the minimum specialist
 * Telegraph Intents needed, builds clean prompts targeted to the live Engine router,
 * estimates cost, and enforces hard per-check & session spending limits.
 */

const URL_REGEX = /https?:\/\/[^\s)>"']+/gi;
const BARCODE_REGEX = /\b(\d{8}|\d{12,14})\b/;

const PRIVATE_OR_UNCHECKABLE_PATTERNS = [
  /\b(private\s+(whatsapp|telegram|wechat|group|chat|dm|memo|contract|deal))\b/i,
  /\b(unpublished|undisclosed|secret\s+inside|off-record|anonymous\s+insider)\b/i,
  /\b(will\s+(double|10x|100x|guarantee\s+profit|moon)\s+(by\s+midnight|tomorrow|next\s+week|in\s+\d+\s+hours))\b/i,
];

/**
 * Extract structured artifacts (URLs, barcodes, suspicious uncheckable phrasing) from input.
 */
export function extractArtifacts(input) {
  const claim = String(input.claim || '').trim();
  const explicitUrl = String(input.url || '').trim();
  const inlineUrls = claim.match(URL_REGEX) || [];
  const urls = Array.from(
    new Set([explicitUrl, ...inlineUrls].filter((u) => /^https?:\/\//i.test(u))),
  );

  const explicitBarcode = String(input.productCode || '').trim();
  const barcodeMatch = claim.match(BARCODE_REGEX);
  const productCode = explicitBarcode || (barcodeMatch ? barcodeMatch[1] : '');

  const textSample = String(input.textSample || '').trim();
  const mediaUrl = String(input.mediaUrl || '').trim();

  const uncheckableMarkers = PRIVATE_OR_UNCHECKABLE_PATTERNS.filter((re) =>
    re.test(`${claim} ${textSample}`),
  ).map((re) => re.source);

  return {
    claim,
    urls,
    productCode,
    textSample,
    mediaUrl,
    uncheckableMarkers,
  };
}

/**
 * Plan which Telegraph Intents to purchase for a consumer check.
 * Enforces `maxCheckBudgetUsdc` and `remainingSessionBudgetUsdc` up front.
 */
export function planVerificationSteps(input, options = {}) {
  const unitPriceUsdc = options.unitPriceUsdc ?? 0.01;
  const maxCheckBudgetUsdc =
    typeof input.maxBudgetUsdc === 'number' && !Number.isNaN(input.maxBudgetUsdc)
      ? input.maxBudgetUsdc
      : (options.maxCheckBudgetUsdc ?? 0.05);
  const remainingSessionBudgetUsdc = options.remainingSessionBudgetUsdc ?? 0.5;
  const effectiveCapUsdc = Math.max(0, Math.min(maxCheckBudgetUsdc, remainingSessionBudgetUsdc));

  const artifacts = extractArtifacts(input);
  const steps = [];

  if (!artifacts.claim && artifacts.urls.length === 0 && !artifacts.productCode && !artifacts.textSample && !artifacts.mediaUrl) {
    const err = new Error('Input must provide at least one of: claim, url, productCode, textSample, or mediaUrl.');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  // 1. URL safety check (highest priority for scam/phishing protection)
  if (artifacts.urls.length > 0) {
    const targetUrl = artifacts.urls[0];
    steps.push({
      id: 'url-safe',
      targetFamily: 'URL_SAFE',
      canonicalIntent: 'URL_SAFE_GENERAL',
      reason: `Verify whether URL ${targetUrl} is listed as phishing, malware, or malicious.`,
      query: `Check whether the URL ${targetUrl} is safe or listed as malicious, phishing, or deceptive on live threat feeds and blocklists. Return clear status and evidence.`,
      estimatedCostUsdc: unitPriceUsdc,
    });
  }

  // 2. Factual claim verification
  if (artifacts.claim) {
    steps.push({
      id: 'fact-check',
      targetFamily: 'FACT_CHECK',
      canonicalIntent: 'FACT_CHECK_GENERAL',
      reason: 'Fact-check the core consumer claim against verifiable public sources.',
      query: `Fact-check the following claim and cite supporting public evidence or state clearly if it is uncheckable/insufficient evidence: "${artifacts.claim}"`,
      estimatedCostUsdc: unitPriceUsdc,
    });
  }

  // 3. Product authenticity / barcode lookup
  if (artifacts.productCode) {
    steps.push({
      id: 'product-authenticity',
      targetFamily: 'PRODUCT_AUTHENTICITY',
      canonicalIntent: 'PRODUCT_AUTHENTICITY_GENERAL',
      reason: `Check registry authenticity for product code / GTIN ${artifacts.productCode}.`,
      query: `Verify product authenticity and official product metadata for barcode/GTIN ${artifacts.productCode}.`,
      estimatedCostUsdc: unitPriceUsdc,
    });
  }

  // 4. Optional AI-generated spam/review text check
  if (artifacts.textSample && artifacts.textSample.length >= 40) {
    steps.push({
      id: 'ai-text-detect',
      targetFamily: 'AI_TEXT_DETECTION',
      canonicalIntent: 'AI_TEXT_DETECTION_GENERAL',
      reason: 'Check whether the listing/review text exhibits synthetic AI-generated patterns.',
      query: `Analyze whether the following consumer review or listing text was written by an AI or a human and report confidence: "${artifacts.textSample.slice(0, 600)}"`,
      estimatedCostUsdc: unitPriceUsdc,
    });
  }

  // 5. Optional media forensic check
  if (artifacts.mediaUrl && /^https?:\/\//i.test(artifacts.mediaUrl)) {
    steps.push({
      id: 'media-forensic',
      targetFamily: 'MEDIA_FORENSIC_VERIFY',
      canonicalIntent: 'MEDIA_FORENSIC_VERIFY_GENERAL',
      reason: `Check media provenance and manipulation signals for ${artifacts.mediaUrl}.`,
      query: `Perform a media forensic and digital manipulation check on the image/media at ${artifacts.mediaUrl}. State whether there is evidence of editing or if evidence is inconclusive.`,
      estimatedCostUsdc: unitPriceUsdc,
    });
  }

  // Enforce hard spending cap BEFORE executing any call
  const maxStepsAffordable = Math.floor((effectiveCapUsdc + 1e-12) / unitPriceUsdc);
  if (maxStepsAffordable < 1) {
    return {
      allowed: false,
      blockedReason: `Spending limit ($${effectiveCapUsdc.toFixed(4)} USDC) is below the minimum single Telegraph call cost ($${unitPriceUsdc.toFixed(4)} USDC). No x402 authorization was signed.`,
      artifacts,
      effectiveCapUsdc,
      requestedSteps: steps,
      approvedSteps: [],
      trimmedSteps: steps,
      estimatedTotalUsdc: 0,
    };
  }

  const approvedSteps = steps.slice(0, maxStepsAffordable);
  const trimmedSteps = steps.slice(maxStepsAffordable);

  return {
    allowed: true,
    blockedReason: null,
    artifacts,
    effectiveCapUsdc,
    requestedSteps: steps,
    approvedSteps,
    trimmedSteps,
    estimatedTotalUsdc: Number((approvedSteps.length * unitPriceUsdc).toFixed(6)),
  };
}
