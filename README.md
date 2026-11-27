# TrustLens — In-Product Consumer Trust, Link & Claim Verifier

**Telegraph Protocol Hackathon Season II — Track 01: Apps & Agents**  
**Target Mission:** [Mission 07 — Consumer Platform (#195)](https://github.com/telegraphprotocol/bounties/issues/195)

TrustLens is an in-product consumer trust and provenance verifier that turns risky marketplace listings, links, claims, and promotional copy into conservative **tri-state verdicts** (`VERIFIED` | `SUSPICIOUS` | `UNKNOWN`) backed by **tamper-evident SHA-256 Claim Receipts** and **real paid autonomous Telegraph Protocol intelligence calls**.

Instead of silently forwarding consumer prompts to a single unverified LLM or forcing dishonest binary True/False labels, TrustLens decomposes each input into the minimal set of specialist Telegraph Intents, enforces hard pre-flight and pre-signing USDC spending caps, normalizes heterogeneous Provider-native outputs (including `findings.items`) conservatively, and fails closed to `UNKNOWN` whenever evidence is missing, low-confidence, private/uncheckable, contradictory, or unreachable.

---

## 1. Customer, Problem & Economics

- **Target Customer:** Consumer marketplaces, social-commerce apps, messaging platforms, browser safety extensions, and creator-storefront trust & safety teams.
- **Core Problem:** Users click phishing giveaway links, buy counterfeit or misleadingly marketed listings, and act on unverified viral claims inside consumer apps. Existing trust & safety stacks either force slow manual moderation queues ($0.50–$3.00+ per human review) or rely on one general-purpose LLM with no specialized threat feeds, no provenance receipt, and high hallucination risk on private/unverifiable claims.
- **Why Telegraph:** TrustLens composes live, independently ranked specialist miners on Telegraph (`URL_SAFE_GENERAL`, `FACT_CHECK_GENERAL`, `PRODUCT_AUTHENTICITY_GENERAL`, `AI_TEXT_DETECTION_GENERAL`, `MEDIA_FORENSIC_VERIFY_GENERAL`) over **dual official Telegraph payment rails** — **Telegraph Escrow API** (`https://backend.telegraphprotocol.com/engine/ask`) and **direct permissionless Base Sepolia x402 v2 EIP-3009** (`https://devnode.telegraphprotocol.com/engine/v1/ask`) — with verifiable payment receipts and zero per-vendor contracts.
- **Observed Unit Economics:** `$0.01–$0.03 USDC` per consumer verification check (`$0.01` per specialist intent on testnet), with hard per-check (`$0.05` default) and per-session (`$0.50` default) caps enforced **before** spending or signing any authorization.

---

## 2. Live Paid Evidence (Verified Against Telegraph Testnet — Epoch 67)

All live runs below were executed autonomously by TrustLens against Telegraph testnet (`https://backend.telegraphprotocol.com/engine/ask` funded via Sepolia testnet Escrow USDC, faucet tx `0x5ccaa905a82725320e379681899a4d803a2ba0f087bfce5cf0f64e6e4ac67fed`) plus a live HTTP `402` x402 v2 quote probe against `https://devnode.telegraphprotocol.com/engine/v1/ask`:

| Evidence File | Test Case | Verdict & Action | Live Routed Intent(s) & Rank-1 Miner(s) | Cost (USDC) | Latency | Telegraph Payment / Signal Proof |
| --- | --- | --- | --- | ---: | ---: | --- |
| [`evidence/live-verified-fact.json`](evidence/live-verified-fact.json) | Established factual claim (`Water boils at 100 °C at 1 atm`) | **`VERIFIED`** (`ALLOW_WITH_RECEIPT`) | `FACT_CHECK_GENERAL` → LiveCert (#4433, rank 1) | `$0.0100` | 13.7 s | Receipt `0x19bba6736101…` (epoch 67), signal `0xd0aca951f944…` |
| [`evidence/live-suspicious-claim.json`](evidence/live-suspicious-claim.json) | Refuted false claim (`Earth is flat / staged Moon landing`) | **`SUSPICIOUS`** (`WARN_DO_NOT_PAY_OR_CLICK`) | `FACT_CHECK_GENERAL` → LiveCert (#4433, rank 1) | `$0.0200` | 25.2 s | Receipt `0xde1f50ae22be…` (epoch 67), signal `0x3180584ac257…` |
| [`evidence/live-uncheckable.json`](evidence/live-uncheckable.json) | Private Telegram rumor / future price guarantee | **`UNKNOWN`** (`ABSTAIN_HUMAN_REVIEW_REQUIRED`) | `FACT_CHECK_GENERAL` → LiveCert (#4433, rank 1) | `$0.0100` | 21.1 s | Receipt `0xf14a0d3f60ac…` (epoch 67), confidence 30% → abstained |
| [`evidence/live-benign.json`](evidence/live-benign.json) | Multi-intent URL + Fact check (`example.com` + boiling point) | **`UNKNOWN`** (`ABSTAIN_HUMAN_REVIEW_REQUIRED`) | `URL_SAFE_GENERAL` → Verity (#5530) + `FACT_CHECK_GENERAL` → LiveCert (#4433) | `$0.0200` | 60.2 s | Receipts `0x4eb3cfd8a20a…` + `0xf15790a36e18…` (Verity returned 60% conf: absence from threat feed does not guarantee safety → conservative abstain!) |
| [`evidence/live-scam.json`](evidence/live-scam.json) | Multi-intent scam offer + real live timeout handling | **`UNKNOWN`** (`ABSTAIN_HUMAN_REVIEW_REQUIRED`) | `URL_SAFE_GENERAL` (#5530) + `FACT_CHECK_GENERAL` (#4433) + `AI_TEXT_DETECTION_GENERAL` (45 s timeout) | `$0.0200` | 83.0 s | Receipts `0x0bc6b3f138a3…` + `0x875b2c174a0a…`; timed-out 3rd step billed `$0.0000` and failed closed cleanly |
| [`evidence/live-budget-refusal.json`](evidence/live-budget-refusal.json) | Failure Case: per-check cap `$0.005 < $0.01` | **`UNKNOWN`** (`BLOCKED_BY_BUDGET_GUARD`) | Blocked pre-flight before signing/billing | `$0.0000` | 0 ms | Zero spend; `sha256:c3c671962f74…` |
| [`evidence/live-402-probe.json`](evidence/live-402-probe.json) | Live devnode x402 v2 quote probe (`devnode.telegraphprotocol.com`) | **`UNKNOWN`** (dry-probe, no signature) | Live HTTP `402` challenge (`eip155:84532`) | `$0.0000` | 2.0 s | `$0.01 USDC` quote to `0xC0A3FB6d3F1f4B54617d29ffbdA4663Af5F96e2e` |

*(Additional smoke call on `URL_SCAN_VERDICT` routed to `ChainSight — Universal Intelligence & Data Oracle (#302, rank 1)`, `$0.0100`, receipt `0x4484ad9fb407478c9d40d38b684e6fbb58f93a16db25637668c14118e974ed09`, epoch 67. Total verified live testnet Escrow spend across initial run: `$0.10 USDC`, confirmed via `GET /engine/escrow/balance` showing `escrowBalance: 5`, `effectiveBalance: 4.9`, `unbilled: 0.1`.)*

---

## 3. Architecture & Mission 07 Intent Discovery

Live discovery against `https://devnode.telegraphprotocol.com/engine/v1/intents` (136 canonical intents active) confirmed active Mission 07 specialist supply:

| TrustLens Step | Canonical Telegraph Intent | Live Miners Observed | Triggered When |
| --- | --- | ---: | --- |
| `url-safe` | `URL_SAFE_GENERAL` | 21 | A URL is provided or extracted from claim text |
| `fact-check` | `FACT_CHECK_GENERAL` | 21 | A factual or promotional consumer claim is provided |
| `product-auth` | `PRODUCT_AUTHENTICITY_GENERAL` | 13 | A product barcode / UPC / EAN / SKU is provided |
| `ai-text-detect` | `AI_TEXT_DETECTION_GENERAL` | 21 | Listing/review copy ≥ 40 chars is provided |
| `media-forensic` | `MEDIA_FORENSIC_VERIFY_GENERAL` | 19 | A media URL is provided |

*(Note: `docs/MISSIONS.md` listed `FACT_CHECKING` as an early placeholder; live inspection of `/engine/v1/intents` confirmed active miners serve under `FACT_CHECK_GENERAL`.)*

### End-to-End Autonomous Machine Flow

```text
Consumer Input (claim / URL / SKU / promo copy)
  │
  ▼
1. Minimal Intent Planner (src/planner.js)
   - Selects only relevant Mission 07 intents (priority-ordered)
   - Detects private/future uncheckable claim markers
   - Enforces per-check & per-session USDC spending caps BEFORE spending/signing
  │
  ▼
2. Dual-Rail Paid Telegraph Client (src/telegraph.js + src/x402.js)
   - Rail A (Escrow): POST https://backend.telegraphprotocol.com/engine/ask (Bearer ANJOMAN_API_KEY)
                      -> live rank-1 specialist routing + epoch payment receipt_hash + signal_hash
   - Rail B (x402 v2): POST https://devnode.telegraphprotocol.com/engine/v1/ask -> HTTP 402
                      -> verifies quoted amount <= cap -> signs EIP-712 TransferWithAuthorization (0 ETH gas)
                      -> retries with PAYMENT-SIGNATURE -> verifies AuthorizationUsed + Transfer on Base Sepolia
  │
  ▼
3. Conservative Tri-State Normalizer (src/verdict.js)
   - Normalizes heterogeneous Provider-native JSON, findings.items, and prose without assuming one schema
   - Negation-aware threat matching (avoids false positives on "not listed on any phishing blocklist")
   - Low confidence (<65%), private/uncheckable claims, cross-signal contradictions
     (ABSTAIN_CONFLICTING_EVIDENCE), and upstream timeouts/errors ALL fail closed to UNKNOWN
  │
  ▼
4. Tamper-Evident Claim Receipt & Ledger (src/receipts.js)
   - Deterministic SHA-256 Claim Receipt JSON + copyable Markdown badge card + JSONL spend ledger
```

---

## 4. Honest Execution Modes (Live vs Probe vs Fixture)

TrustLens **never** mislabels simulated or dry-run responses as live payments. Every receipt, UI banner, and Markdown export explicitly carries `executionMode` and `isLivePayment`:

| Mode | `isLivePayment` | Network Activity | Purpose |
| --- | --- | --- | --- |
| **`live`** | `true` | Real paid Telegraph Escrow (`POST /engine/ask`) or Base Sepolia x402 v2 EIP-3009 call | Genuine autonomous machine-to-machine paid verification |
| **`probe`** | `false` | Live `GET /engine/v1/intents` + live `POST /engine/v1/ask` HTTP `402` quote (`$0.00` spent) | Zero-wallet live node & quote inspection |
| **`fixture`** | `false` | Deterministic offline replay of all 6 Mission 07 scenarios (`OFFLINE FIXTURE REPLAY`) | Fast offline CI regression & UI testing |

---

## 5. Quick Start (Judge-Reproducible)

### Requirements
- Node.js `>= 20` (tested on Node `v24.18.0`; single runtime dependency: `ethers@^6.13.4`).

### 1) Install & Run Unit Tests (Zero Credentials Required)

```bash
npm install
npm test
```

Expected: `8/8` tests pass (minimal-intent planner, spending-cap refusal, EIP-712 x402 signature recovery & cap enforcement, negation-aware tri-state normalizer including `findings.items`, all 6 Mission 07 presets + SHA-256 tamper verification, simulated upstream 502 fail-closed handling, and HTTP server integration).

### 2) Probe Live Telegraph Devnode (Zero Credentials Required)

```bash
npm run probe
```

Queries live `https://devnode.telegraphprotocol.com/engine/v1/intents` and captures a live HTTP `402` x402 v2 quote (`$0.01 USDC` on `eip155:84532`).

### 3) Run Offline 6-Preset Regression Suite

```bash
npm run demo:offline
```

Runs all 6 Mission 07 scenarios (`benign-control` → `VERIFIED`, `scam-listing` → `SUSPICIOUS`, `uncheckable-claim` → `UNKNOWN`, `conflicting-evidence` → `UNKNOWN` / `ABSTAIN_CONFLICTING_EVIDENCE`, `failure-budget-cap` → `BLOCKED_BY_BUDGET_GUARD`, `failure-upstream` → fail-closed `UNKNOWN`).

### 4) Run Real Live Paid Telegraph Calls (Testnet)

```bash
cp .env.example .env
# Option A (fastest): Set ANJOMAN_API_KEY=anjoman_... (claim free 5 Sepolia USDC at anjoman.ai/dashboard/faucet and deposit to escrow)
# Option B (direct x402): Set AGENT_PRIVATE_KEY=0x... (dedicated Base Sepolia testnet wallet funded via faucet.circle.com, 0 ETH gas)

node src/cli.js check --claim "Water boils at 100 degrees Celsius at standard atmospheric pressure (1 atm)." --mode live
node src/cli.js check --preset uncheckable-claim --mode live
node src/cli.js check --preset failure-budget-cap --mode live
```

### 5) Launch Interactive Web UI & REST API

```bash
npm start
# Open http://127.0.0.1:8787
```

API Endpoints: `GET /api/status`, `GET /api/telegraph/live`, `GET /api/presets`, `GET /api/ledger`, `POST /api/verify`.

---

## 6. Security, Guardrails & Observed Live Network Gaps

### Key & Spend Protection
- Credentials (`ANJOMAN_API_KEY`, `AGENT_PRIVATE_KEY`) are read only from `.env` / process environment, excluded by `.gitignore`, never logged, and never exposed over HTTP.
- Dual-layer spending caps (`src/planner.js` pre-flight check + `src/x402.js` pre-signature `BUDGET_EXCEEDED` guard) guarantee zero payment when a quote or planned check exceeds the user-configured cap.

### Real Live Limitations & Network Observations (Honest Testnet Findings)
1. **Latency & Timeout Gaps Observed Live:** During live Mission 07 testing against Telegraph testnet, `FACT_CHECK_GENERAL` (`LiveCert #4433`) responded in 13.7–44.6 s and `URL_SAFE_GENERAL` (`Verity #5530`) in 12.0–15.6 s, while `AI_TEXT_DETECTION_GENERAL` exceeded our 45 s request timeout (`evidence/live-scam.json`). TrustLens handles this safely by aborting cleanly, spending `$0.0000` on the timed-out step, and failing closed to `UNKNOWN`.
2. **Epistemic Humility on Unlisted URLs:** Live `URL_SAFE_GENERAL` (`Verity #5530`) returned `confidence: 0.60` for `https://example.com` with the accurate disclosure that absence from checked blocklists does not prove safety. TrustLens deliberately treats `<65%` confidence as `UNKNOWN` rather than overclaiming safety.
3. **Production Readiness Remaining:** Moving to mainnet consumer traffic requires parallelizing independent intents (currently sequential for strict per-step budget accounting), tightening miner latency SLAs (<3 s target for interactive checkout), and switching endpoints/chain IDs to production USDC.
4. **Disclosure:** The Base Sepolia x402 v2 EIP-3009 signing and settlement verification logic follows protocol conventions from `telegraphprotocol/telegraph-examples`. Implementation and test authoring were assisted by AI coding tools and verified live against Telegraph testnet.

---

## License

MIT
