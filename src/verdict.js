/**
 * Conservative Tri-State Verdict Normalizer for Mission 07 (Consumer Platform).
 *
 * Telegraph does not enforce one universal schema across Providers at the protocol
 * layer. This normalizer maps heterogeneous Provider-native JSON, findings.items,
 * or prose responses into a strict tri-state signal:
 *   - SUPPORTED   (benign / verified safe / corroborated)
 *   - SUSPICIOUS  (malicious URL, confirmed false/scam, high-confidence manipulation)
 *   - UNKNOWN     (uncheckable, low confidence, empty/ambiguous, or upstream error)
 *
 * Crucially, it NEVER forces a binary True/False verdict when evidence is missing,
 * uncheckable, or contradictory.
 */

const NEGATIVE_REGEX =
  /\b(?:malicious|phishing|scam|fraudulent|fraud|counterfeit|deceptive|unsafe|suspicious|blocklisted|blacklisted|high[\s_-]?risk|fabricated|manipulated|spliced|deepfake|false|pants on fire|refuted|debunked|synthetic|ai[\s_-]?generated|misleading|fake)\b/i;

const POSITIVE_REGEX =
  /\b(?:safe|clean|benign|verified|authentic|genuine|true|accurate|corroborated|legitimate|human[\s_-]?written|low[\s_-]?risk)\b/i;

const UNKNOWN_REGEX =
  /\b(?:unknown|unverifiable|uncheckable|insufficient evidence|inconclusive|ambiguous|cannot be verified|cannot verify|no public record|mixed|disputed|uncertain|unconfirmed|medium[\s_-]?risk)\b/i;

const NEGATED_THREAT_PHRASE_REGEX =
  /\b(?:no|not|zero|without|free of|never)\s+(?:known\s+|active\s+|any\s+|evidence of\s+|signs of\s+)?(?:listed(?:\s+on)?(?:\s+any)?\s+)?(?:phishing|malware|malicious|scam|fraud|threat|threats|blocklist|blacklist|manipulation|tampering|deepfake|suspicious|deceptive|fake|ai[\s_-]?generated)[^.;,\n]*/gi;

function unwrapFindings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const items = raw?.findings?.items;
  if (!Array.isArray(items)) return {};
  const mapped = {};
  for (const item of items) {
    if (!item || typeof item.name !== 'string') continue;
    if (mapped[item.name] === undefined && item.value !== undefined && item.value !== null) {
      mapped[item.name] = item.value;
    }
  }
  return mapped;
}

function extractConfidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['confidence', 'score', 'probability', 'certainty']) {
    const val = raw[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val > 1 && val <= 100 ? val / 100 : Math.max(0, Math.min(1, val));
    }
  }
  if (raw.result && typeof raw.result === 'object') {
    const nested = extractConfidence(raw.result);
    if (nested !== null) return nested;
  }
  const findings = unwrapFindings(raw);
  for (const key of ['confidence', 'score', 'probability', 'certainty']) {
    const val = findings[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val > 1 && val <= 100 ? val / 100 : Math.max(0, Math.min(1, val));
    }
  }
  return null;
}

function extractPrimaryLabels(obj, findings = {}) {
  const parts = [];
  for (const source of [obj, findings]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['verdict', 'label', 'status', 'classification', 'risk_level', 'rating']) {
      if (typeof source[key] === 'string' && source[key].trim()) {
        parts.push(source[key].trim());
      }
    }
  }
  return [...new Set(parts)].join(' | ');
}

function extractProseText(raw, findings = {}) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object') return String(raw);

  const inner = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  const parts = [];
  for (const source of [inner, findings, raw]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['summary', 'explanation', 'answer', 'signal', 'message', 'text', 'reason', 'details']) {
      if (typeof source[key] === 'string' && source[key].trim()) {
        const val = source[key].trim();
        if (!parts.includes(val)) parts.push(val);
      }
    }
  }
  if (parts.length > 0) return parts.join(' ');
  const primary = extractPrimaryLabels(inner, findings);
  if (primary) return primary;
  return JSON.stringify(inner);
}

function stripNegatedThreats(text) {
  return String(text || '').replace(NEGATED_THREAT_PHRASE_REGEX, ' [negated_threat] ');
}

/**
 * Normalize one Telegraph provider result into { signal, confidence, summary, uncertainty }.
 */
export function normalizeProviderSignal(step, rawResult, { error = null, uncheckableMarkers = [] } = {}) {
  if (error) {
    if (error.code === 'LIVE_402_DRY_PROBE') {
      return {
        signal: 'UNKNOWN',
        confidence: 0,
        summary: error.message,
        uncertainty:
          'Dry-probe verified the live Telegraph HTTP 402 x402 challenge without signing payment; configure ANJOMAN_API_KEY or AGENT_PRIVATE_KEY and run in live mode to pay and obtain miner verdicts.',
      };
    }
    return {
      signal: 'UNKNOWN',
      confidence: 0,
      summary: `Provider check failed (${error.code || 'ERROR'}): ${error.message}`,
      uncertainty: 'Upstream provider failed or timed out; failing closed to UNKNOWN.',
    };
  }

  if (rawResult === null || rawResult === undefined || (typeof rawResult === 'string' && rawResult.trim() === '')) {
    return {
      signal: 'UNKNOWN',
      confidence: 0,
      summary: 'Provider returned an empty response.',
      uncertainty: 'No verifiable evidence returned by upstream miner.',
    };
  }

  const confidence = extractConfidence(rawResult);
  const findings = unwrapFindings(rawResult);
  const inner = rawResult?.result && typeof rawResult.result === 'object' ? rawResult.result : rawResult;
  const primaryLabels = extractPrimaryLabels(inner, findings);
  const proseText = extractProseText(rawResult, findings);
  const displaySummary = (proseText || primaryLabels || JSON.stringify(rawResult)).slice(0, 280);

  // Low-confidence outputs must abstain instead of forcing binary certainty
  if (confidence !== null && confidence < 0.65) {
    return {
      signal: 'UNKNOWN',
      confidence,
      summary: displaySummary,
      uncertainty: `Provider confidence (${Math.round(confidence * 100)}%) is below the 65% decision threshold.`,
    };
  }

  // Explicit uncheckable / ambiguous language in primary verdict labels overrides binary labels
  if (primaryLabels && UNKNOWN_REGEX.test(primaryLabels)) {
    return {
      signal: 'UNKNOWN',
      confidence: confidence ?? 0.35,
      summary: displaySummary,
      uncertainty: 'Upstream provider reported insufficient, ambiguous, or uncheckable evidence.',
    };
  }

  // Evaluate structured boolean & primary classification fields first
  let explicitNegBool = false;
  let explicitPosBool = false;
  for (const source of [inner, findings]) {
    if (typeof source !== 'object' || source === null) continue;
    if (
      source.is_malicious === true ||
      source.is_phishing === true ||
      source.is_scam === true ||
      source.is_fraud === true ||
      source.is_ai === true ||
      source.ai_generated === true ||
      source.safe === false ||
      source.is_safe === false ||
      source.authentic === false ||
      source.verified === false ||
      source.factual === false
    ) {
      explicitNegBool = true;
    }
    if (
      source.is_malicious === false ||
      source.is_phishing === false ||
      source.is_scam === false ||
      source.is_fraud === false ||
      source.is_ai === false ||
      source.ai_generated === false ||
      source.safe === true ||
      source.is_safe === true ||
      source.authentic === true ||
      source.verified === true ||
      source.factual === true
    ) {
      explicitPosBool = true;
    }
  }

  const primaryNeg = Boolean(primaryLabels && NEGATIVE_REGEX.test(primaryLabels));
  const primaryPos = Boolean(primaryLabels && POSITIVE_REGEX.test(primaryLabels));

  const structNeg = explicitNegBool || primaryNeg;
  const structPos = explicitPosBool || primaryPos;

  if (structNeg && structPos) {
    return {
      signal: 'UNKNOWN',
      confidence: confidence ?? 0.45,
      summary: displaySummary,
      uncertainty: 'Provider structured fields contain conflicting positive and negative indicators; abstaining.',
    };
  }

  if (structNeg) {
    return {
      signal: 'SUSPICIOUS',
      confidence: confidence ?? 0.85,
      summary: displaySummary,
      uncertainty: confidence !== null && confidence < 0.75 ? 'Flagged with moderate confidence; verify manually.' : null,
    };
  }

  if (structPos) {
    if (step.id === 'fact-check' && uncheckableMarkers.length > 0) {
      return {
        signal: 'UNKNOWN',
        confidence: Math.min(confidence ?? 0.5, 0.45),
        summary: displaySummary,
        uncertainty:
          'Claim references private, undisclosed, or future-guaranteed outcomes that cannot be independently verified on public records; downgraded to UNKNOWN.',
      };
    }
    return {
      signal: 'SUPPORTED',
      confidence: confidence ?? 0.85,
      summary: displaySummary,
      uncertainty: null,
    };
  }

  // Fallback: free-form prose classification (with negation-aware threat stripping)
  if (UNKNOWN_REGEX.test(proseText)) {
    return {
      signal: 'UNKNOWN',
      confidence: confidence ?? 0.35,
      summary: displaySummary,
      uncertainty: 'Upstream provider reported insufficient, ambiguous, or uncheckable evidence.',
    };
  }

  const sanitizedProse = stripNegatedThreats(proseText);
  const proseNeg = NEGATIVE_REGEX.test(sanitizedProse);
  const prosePos = POSITIVE_REGEX.test(sanitizedProse) || sanitizedProse.includes('[negated_threat]');

  if (proseNeg && prosePos) {
    return {
      signal: 'UNKNOWN',
      confidence: confidence ?? 0.45,
      summary: displaySummary,
      uncertainty: 'Provider prose contains mixed positive and negative indicators; abstaining.',
    };
  }

  if (proseNeg) {
    return {
      signal: 'SUSPICIOUS',
      confidence: confidence ?? 0.82,
      summary: displaySummary,
      uncertainty: null,
    };
  }

  if (prosePos) {
    if (step.id === 'fact-check' && uncheckableMarkers.length > 0) {
      return {
        signal: 'UNKNOWN',
        confidence: Math.min(confidence ?? 0.5, 0.45),
        summary: displaySummary,
        uncertainty:
          'Claim references private, undisclosed, or future-guaranteed outcomes that cannot be independently verified on public records; downgraded to UNKNOWN.',
      };
    }
    return {
      signal: 'SUPPORTED',
      confidence: confidence ?? 0.82,
      summary: displaySummary,
      uncertainty: null,
    };
  }

  return {
    signal: 'UNKNOWN',
    confidence: confidence ?? 0.4,
    summary: displaySummary,
    uncertainty: 'Provider response did not contain a clear verifiable verdict label; failing closed to UNKNOWN.',
  };
}

/**
 * Aggregate all step signals into a single conservative tri-state verdict + action.
 */
export function aggregateVerdict({ stepResults, plan }) {
  if (!plan.allowed) {
    return {
      verdict: 'UNKNOWN',
      action: 'BLOCKED_BY_BUDGET_GUARD',
      confidence: 0,
      headline: 'Check refused before payment: spending limit exceeded',
      explanation: plan.blockedReason,
      contradictions: [],
      uncertaintyFactors: [plan.blockedReason],
    };
  }

  if (!stepResults || stepResults.length === 0) {
    return {
      verdict: 'UNKNOWN',
      action: 'ABSTAIN_HUMAN_REVIEW_REQUIRED',
      confidence: 0,
      headline: 'No verification evidence collected',
      explanation: 'No specialist intelligence steps completed; refusing binary judgment.',
      contradictions: [],
      uncertaintyFactors: ['Zero completed checks.'],
    };
  }

  const supported = stepResults.filter((s) => s.normalized.signal === 'SUPPORTED');
  const suspicious = stepResults.filter((s) => s.normalized.signal === 'SUSPICIOUS');
  const unknown = stepResults.filter((s) => s.normalized.signal === 'UNKNOWN');

  const contradictions = [];
  if (supported.length > 0 && suspicious.length > 0) {
    contradictions.push(
      `Disagreement across specialist checks: ${supported.map((s) => s.canonicalIntent).join(', ')} returned SUPPORTED while ${suspicious.map((s) => s.canonicalIntent).join(', ')} returned SUSPICIOUS.`,
    );
  }

  const uncertaintyFactors = [
    ...new Set(stepResults.map((s) => s.normalized.uncertainty).filter(Boolean)),
  ];

  if (plan.trimmedSteps.length > 0) {
    uncertaintyFactors.push(
      `${plan.trimmedSteps.length} lower-priority check(s) skipped due to per-check spending cap ($${plan.effectiveCapUsdc.toFixed(4)} USDC): ${plan.trimmedSteps.map((s) => s.canonicalIntent).join(', ')}.`,
    );
  }

  // Case 1: Hard safety signal (phishing/malicious URL) with no cross-check contradiction
  const criticalUrlThreat = suspicious.find((s) => s.id === 'url-safe');
  if (criticalUrlThreat && contradictions.length === 0) {
    const avgConf =
      suspicious.reduce((acc, s) => acc + (s.normalized.confidence ?? 0.8), 0) / suspicious.length;
    return {
      verdict: 'SUSPICIOUS',
      action: 'WARN_DO_NOT_PAY_OR_CLICK',
      confidence: Number(avgConf.toFixed(2)),
      headline: 'High-risk consumer warning: malicious link or deceptive claim detected',
      explanation: `Telegraph specialist checks flagged ${suspicious.map((s) => s.canonicalIntent).join(' + ')} as suspicious. Hold transaction and warn user.`,
      contradictions,
      uncertaintyFactors,
    };
  }

  // Case 2: Cross-signal contradiction -> surface disagreement explicitly as UNKNOWN (do not average away!)
  if (contradictions.length > 0) {
    return {
      verdict: 'UNKNOWN',
      action: 'ABSTAIN_CONFLICTING_EVIDENCE',
      confidence: 0.4,
      headline: 'Conflicting specialist signals — abstaining instead of forcing binary verdict',
      explanation: `${contradictions[0]} TrustLens surfaces the contradiction rather than collapsing it into a misleading True/False label.`,
      contradictions,
      uncertaintyFactors: [...uncertaintyFactors, ...contradictions],
    };
  }

  // Case 3: Suspicious consensus (no contradictions)
  if (suspicious.length > 0 && supported.length === 0) {
    const avgConf =
      suspicious.reduce((acc, s) => acc + (s.normalized.confidence ?? 0.8), 0) / suspicious.length;
    return {
      verdict: 'SUSPICIOUS',
      action: 'WARN_DO_NOT_PAY_OR_CLICK',
      confidence: Number(avgConf.toFixed(2)),
      headline: 'Suspicious consumer content flagged by Telegraph intelligence',
      explanation: `${suspicious.length} of ${stepResults.length} specialist check(s) flagged risk indicators (${suspicious.map((s) => s.canonicalIntent).join(', ')}).`,
      contradictions,
      uncertaintyFactors,
    };
  }

  // Case 4: Any UNKNOWN or failed check prevents claiming VERIFIED (fail closed!)
  if (unknown.length > 0) {
    return {
      verdict: 'UNKNOWN',
      action: 'ABSTAIN_HUMAN_REVIEW_REQUIRED',
      confidence: Number(
        (
          stepResults.reduce((acc, s) => acc + (s.normalized.confidence ?? 0.35), 0) /
          stepResults.length
        ).toFixed(2),
      ),
      headline: 'Insufficient or unverifiable evidence — returning UNKNOWN',
      explanation: `${unknown.length} of ${stepResults.length} check(s) could not establish verifiable public proof (${unknown.map((s) => s.canonicalIntent).join(', ')}). Refusing forced binary judgment.`,
      contradictions,
      uncertaintyFactors,
    };
  }

  // Case 5: Clean corroboration across all executed steps
  const avgConf =
    supported.reduce((acc, s) => acc + (s.normalized.confidence ?? 0.85), 0) / supported.length;
  return {
    verdict: 'VERIFIED',
    action: 'ALLOW_WITH_RECEIPT',
    confidence: Number(avgConf.toFixed(2)),
    headline: 'Verified benign / corroborated with Telegraph provenance receipt',
    explanation: `All ${supported.length} specialist check(s) corroborated the input with acceptable confidence and zero threat-feed hits.`,
    contradictions,
    uncertaintyFactors,
  };
}
