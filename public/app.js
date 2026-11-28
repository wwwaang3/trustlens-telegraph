let currentPresets = [];
let activePresetId = null;
let lastReceipt = null;
let lastMarkdown = '';

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchStatus() {
  const res = await fetch('/api/status?balance=1');
  const data = await res.json();
  $('nodePill').textContent = `Node: ${(data.activePaymentRail === 'escrow' ? data.backendUrl : data.nodeUrl).replace(/^https?:\/\//, '')}`;
  const walletPill = $('walletPill');
  if (data.activePaymentRail === 'escrow') {
    const eb = data.escrowBalance?.effectiveBalance ?? data.escrowBalance?.escrowBalance;
    const balTxt = eb !== undefined ? ` · $${Number(eb).toFixed(2)} USDC` : '';
    walletPill.textContent = `Live Rail: Telegraph Escrow${balTxt}`;
    walletPill.className = 'pill pill-live';
  } else if (data.walletConfigured) {
    walletPill.textContent = `Live Rail: x402 ${data.payerAddress.slice(0, 6)}…${data.payerAddress.slice(-4)}`;
    walletPill.className = 'pill pill-live';
  } else {
    walletPill.textContent = 'Live Rail: Not Set (Probe / Fixture Ready)';
    walletPill.className = 'pill pill-neutral';
    if ($('modeSelect').value === 'live') $('modeSelect').value = 'fixture';
  }
  $('budgetPill').textContent = `Session Remaining: $${Number(data.remainingSessionBudgetUsdc).toFixed(4)} USDC`;
  renderLedger(data.ledger);
}

function renderLedger(ledger) {
  $('ledgerCountBadge').textContent = `${ledger.totalChecks} runs`;
  $('mTotal').textContent = String(ledger.totalChecks);
  $('mBreakdown').textContent = `${ledger.verdicts.VERIFIED} / ${ledger.verdicts.SUSPICIOUS} / ${ledger.verdicts.UNKNOWN}`;
  $('mSpent').textContent = `$${Number(ledger.totalCostUsd).toFixed(4)}`;
  $('mAvg').textContent = `$${Number(ledger.avgCostPerCheckUsd).toFixed(4)}`;

  const recentEl = $('recentRuns');
  if (!ledger.recent || ledger.recent.length === 0) {
    recentEl.innerHTML = '<div class="live-supply">No checks recorded yet.</div>';
    return;
  }
  recentEl.innerHTML = ledger.recent
    .slice(0, 6)
    .map(
      (r) => `
      <div class="recent-row">
        <span class="verdict-badge v-${escapeHtml(r.verdict)}">${escapeHtml(r.verdict)}</span>
        <span>${escapeHtml((r.input?.claim || r.input?.url || r.runId).slice(0, 48))}</span>
        <span style="font-family:var(--mono);color:var(--muted)">${escapeHtml(r.executionMode)} · $${Number(r.accounting?.totalCostUsd || 0).toFixed(4)}</span>
      </div>`,
    )
    .join('');
}

async function loadPresets() {
  const res = await fetch('/api/presets');
  const data = await res.json();
  currentPresets = data.presets || [];
  const container = $('presetButtons');
  container.innerHTML = '';
  for (const p of currentPresets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.textContent = p.label;
    btn.title = p.description;
    btn.addEventListener('click', () => {
      activePresetId = p.id;
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('claimInput').value = p.input.claim || '';
      $('urlInput').value = p.input.url || '';
      $('productInput').value = p.input.productCode || '';
      $('textSampleInput').value = p.input.textSample || '';
      $('budgetInput').value = p.input.maxBudgetUsdc ?? 0.05;
      $('simulateFailureCheckbox').checked = Boolean(p.input.simulateUpstreamFailure);
    });
    container.appendChild(btn);
  }
}

function renderResult(receipt, markdown) {
  lastReceipt = receipt;
  lastMarkdown = markdown;

  $('emptyState').hidden = true;
  $('resultPanel').hidden = false;
  $('receiptActions').hidden = false;

  const banner = $('modeBanner');
  if (receipt.executionMode === 'live') {
    banner.className = 'mode-banner mode-live';
    banner.textContent = `LIVE TELEGRAPH TESTNET (${receipt.network}) — Real paid autonomous Telegraph intelligence call`;
  } else if (receipt.executionMode === 'probe') {
    banner.className = 'mode-banner mode-probe';
    banner.textContent = `LIVE 402 DRY-PROBE (${receipt.network}) — Verified live HTTP 402 quote ($0 spent; add ANJOMAN_API_KEY or AGENT_PRIVATE_KEY to pay)`;
  } else {
    banner.className = 'mode-banner mode-fixture';
    banner.textContent = 'OFFLINE FIXTURE REPLAY — Deterministic test replay (NOT a live on-chain payment)';
  }

  const vBadge = $('verdictBadge');
  vBadge.textContent = `${receipt.verdict} (${Math.round(receipt.confidence * 100)}%)`;
  vBadge.className = `verdict-badge v-${receipt.verdict}`;

  $('actionBadge').textContent = receipt.action;
  $('costBadge').textContent = `$${Number(receipt.accounting.totalCostUsd).toFixed(4)} USDC · ${receipt.accounting.totalLatencyMs}ms`;
  $('verdictHeadline').textContent = receipt.headline;
  $('verdictExplanation').textContent = receipt.explanation;

  if (receipt.uncertaintyFactors && receipt.uncertaintyFactors.length > 0) {
    $('uncertaintyBox').hidden = false;
    $('uncertaintyList').innerHTML = receipt.uncertaintyFactors
      .map((u) => `<li>${escapeHtml(u)}</li>`)
      .join('');
  } else {
    $('uncertaintyBox').hidden = true;
  }

  const checksEl = $('checksList');
  if (!receipt.checks || receipt.checks.length === 0) {
    checksEl.innerHTML = '<div class="check-item">No Telegraph calls executed (blocked by spending cap before signing).</div>';
  } else {
    checksEl.innerHTML = receipt.checks
      .map((c) => {
        const minerInfo = c.minerName ? `${escapeHtml(c.minerName)} (#${escapeHtml(c.minerId)})` : 'No miner executed';
        const settleLink = c.settlement?.explorerUrl
          ? `<a href="${escapeHtml(c.settlement.explorerUrl)}" target="_blank" rel="noreferrer">Base Sepolia TX ↗</a>`
          : c.payment?.receiptHash
            ? `Telegraph Escrow Receipt: <code>${escapeHtml(c.payment.receiptHash)}</code> (epoch ${escapeHtml(c.payment.epochId ?? '?')})`
            : '';
        const probeInfo = c.probe?.x402Required
          ? `Live 402 quote: $${Number(c.probe.quoteUsd).toFixed(4)} USDC · payTo ${escapeHtml(c.probe.payTo)} · ${escapeHtml(c.probe.network)}`
          : '';
        const sigInfo = c.signalHash ? `signal_hash: ${escapeHtml(c.signalHash)}` : '';
        return `
          <div class="check-item">
            <div class="check-head">
              <strong>${escapeHtml(c.routedIntent || c.requestedIntent)}</strong>
              <span class="verdict-badge v-${c.signal === 'SUPPORTED' ? 'VERIFIED' : c.signal}">${escapeHtml(c.signal)}</span>
            </div>
            <div>${escapeHtml(c.summary)}</div>
            <div class="check-meta">
              Miner: ${minerInfo} · Cost: $${Number(c.costUsd || 0).toFixed(4)} USDC · ${c.latencyMs}ms
              ${sigInfo ? `<br/>${sigInfo}` : ''}
              ${probeInfo ? `<br/>${probeInfo}` : ''}
              ${settleLink ? `<br/>${settleLink}` : ''}
            </div>
          </div>`;
      })
      .join('');
  }

  $('receiptJson').textContent = JSON.stringify(receipt, null, 2);
}

async function probeLiveDevnode() {
  const btn = $('probeLiveBtn');
  btn.disabled = true;
  btn.textContent = 'Probing devnode…';
  try {
    const res = await fetch('/api/telegraph/live');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('devnodeTotalBadge').textContent = `${data.totalCanonicalIntents} live intents`;
    const p = data.x402Probe;
    const rows = (data.mission07Intents || [])
      .map(
        (i) =>
          `<tr><td><code>${escapeHtml(i.intent_id)}</code></td><td>${i.miner_count}</td><td>${escapeHtml(i.lifecycle_state)}</td></tr>`,
      )
      .join('');
    $('liveSupplyContent').innerHTML = `
      <div>
        Live HTTP 402 quote: <strong>$${Number(p.quoteUsd).toFixed(4)} USDC</strong> on <code>${escapeHtml(p.network)}</code>
        (${p.latencyMs}ms)<br/>
        x402 Receiver: <code>${escapeHtml(p.payTo)}</code>
      </div>
      <table class="intent-table">
        <thead><tr><th>Mission 07 Intent</th><th>Live Miners</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    $('liveSupplyContent').textContent = `Probe failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Probe Live Devnode (402 Quote)';
  }
}

$('verifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('runVerifyBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const payload = {
      claim: $('claimInput').value.trim(),
      url: $('urlInput').value.trim(),
      productCode: $('productInput').value.trim(),
      textSample: $('textSampleInput').value.trim(),
      maxBudgetUsdc: Number.parseFloat($('budgetInput').value),
      mode: $('modeSelect').value,
      presetId: activePresetId,
      simulateUpstreamFailure: $('simulateFailureCheckbox').checked,
    };
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderResult(data.receipt, data.markdown);
    await fetchStatus();
  } catch (err) {
    alert(`Verification error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Verification & Issue Receipt';
  }
});

$('clearBtn').addEventListener('click', () => {
  activePresetId = null;
  document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  $('claimInput').value = '';
  $('urlInput').value = '';
  $('productInput').value = '';
  $('textSampleInput').value = '';
  $('budgetInput').value = '0.05';
  $('simulateFailureCheckbox').checked = false;
});

for (const inputId of ['claimInput', 'urlInput', 'productInput', 'textSampleInput']) {
  $(inputId).addEventListener('input', () => {
    activePresetId = null;
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  });
}

$('probeLiveBtn').addEventListener('click', probeLiveDevnode);

$('copyMdBtn').addEventListener('click', async () => {
  if (!lastMarkdown) return;
  await navigator.clipboard.writeText(lastMarkdown);
  $('copyMdBtn').textContent = 'Copied!';
  setTimeout(() => ($('copyMdBtn').textContent = 'Copy Markdown'), 1500);
});

$('downloadJsonBtn').addEventListener('click', async () => {
  if (!lastReceipt) return;
  const blob = new Blob([JSON.stringify(lastReceipt, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${lastReceipt.runId}.json`;
  a.click();
});

loadPresets();
fetchStatus();
