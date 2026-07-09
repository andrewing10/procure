# V8 Pipeline Core — Zhimao Omni-Matrix

Multi-pillar B2B buyer discovery pipeline. Discovers overseas buyers via 6 parallel signal pillars, cleans through LLM intake, enriches with contact info via Playwright, deduplicates, and writes qualified leads to Supabase (`data_intel_l1_companies` + `data_intel_graph_edges`) via Step 5.

## Pipeline Stages

```
Step 0  →  Geo-Orchestrator & Bilingual Dork Generator    (Gemini)
Step 1  →  Multi-Pillar Raw Collection                    (Serper / LBS / Tenders / Exhibitions)
Step 2  →  LLM Strict Entity Intake & CN-filter           (Gemini, batched)
Step 3  →  BOM Deduction + Playwright Contact Enrichment  (Gemini + Playwright)
Step 4  →  Global Dedupe & Schema Normalisation
Step 5  →  Routing Gateway → SQLite + Supabase L1 ingest
```

## Quick Start

```bash
cp .env.example .env
# fill in GEMINI_KEY, SERPER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

npm install
npx playwright install chromium

# Run one pipeline session manually
node zhimao_v8_ultimate_master.js mx "Consumer Electronics"

# Run the continuous loop (picks next task from taxonomy LRU)
npm run loop
```

## Production deploy (Singapore desktop)

Self-host workers with pm2 (Supabase stays in cloud for Phase 1). See:

- [`deploy/procure/README.md`](deploy/procure/README.md) — install, env, cutover from Render
- [`deploy/host/README.md`](deploy/host/README.md) — host baseline, UFW, Nginx (Phase 2+)

## Dual-Repo Mirror Contracts (与 zhimao 仓约定)

This worker shares **single-source modules** with the zhimao Next.js app.
Whenever you touch any of these on either side, you **must** mirror the change
on the other repo. See `zhimao/AGENTS.md` for the canonical agreement table.

| Concern | procure (single source / mirror) | zhimao |
|---------|-------------------------------|--------|
| 6-layer contact enricher | `v8_lib_contact_enricher.js` (CJS) | `apps/web/lib/skills/{htmlFetcher,contactExtractor,contactLlmExtract,pageScreenshot}.ts` |
| Vision screenshot provider chain | `v8_lib_page_screenshot.cjs` | `apps/web/lib/skills/pageScreenshot.ts` |
| **B2B buyer email quality** (NON_BUYER_HOSTS / placeholder / brand-match) | `v8_lib_email_quality.js` | `apps/web/lib/skills/emailQuality.ts` |
| Quality gate REJECT_REASONS | `v8_quality_gate.js` (incl. `PLACEHOLDER_EMAIL` / `AGGREGATOR_EMAIL` / `EMAIL_BRAND_MISMATCH`) | reason dict in `zhimao/AGENTS.md` |
| **B2C biz-type blacklist groups + CATEGORY_B2C_WHITELIST** | `v8_quality_gate.js` (`BIZ_ANTI_GROUPS` 9 named groups + 12 whitelist rules + `isBizTypeBlacklisted(name, category)` + `evaluateLead(lead, { category })`) | `apps/web/lib/data-intel/quality.ts` (same shape + `computeQualityGrade({...category})`) |
| Quality-grade predicates (`inferEntityType` / `isClosedBusiness` / `isJunkDomain` / `isAggregatorDomain`) | `v8_quality_gate.js` | `apps/web/lib/data-intel/quality.ts` |

`DISCOVERY_CATEGORY` env is the canonical category source for `evaluateLead` —
`v8_step5_routing_gateway.js` passes it via `{ category: TARGET_CATEGORY_FROM_ENV }` so that
flour-task → bakery / cosmetic-raw-material → spa / hotel-supply → hotel are no longer
killed by the B2C blacklist's one-size-fits-all rule.

**Regression scripts (both must pass on every release):**

| Script | What it verifies |
|--------|------------------|
| `node scripts/verify-contact-enricher.js` | 6-layer enrichment pipeline (mailto / deobf / BFS / Serper / LLM text / vision) |
| `node scripts/verify-email-quality.js` | 42 cases — `isBuyerEmail` core, real-log 18 non-buyer emails, `evaluateLead` G-segment integration |
| `node scripts/verify-biz-type-whitelist.js` | 46 cases — 9 biz-anti groups + 12 CATEGORY_B2C_WHITELIST rules + `evaluateLead`/`computeQualityGrade` end-to-end + backwards-compat (no category = old behavior) |
| `npm run test:quality-smoke` | 14 cases — all `REJECT_REASONS` branches |

## Environment Variables

See `.env.example` for the full list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_KEY` | Yes | Google AI Studio key |
| `SERPER_API_KEY` | Yes | Serper.dev search key |
| `SUPABASE_URL` | Yes | Supabase project URL (Step 5 + discovery worker) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for direct L1 / job tables |
| `USE_PROXY` | No | Set `true` to enable BrightData proxy in Step 3 |

## Step 5 — Supabase L1 ingest

Qualified leads are written by `v8_direct_l1_ingest.js`: upsert `data_intel_l1_companies` on `(name_canonical, country)` with `ignoreDuplicates`, then insert `PURCHASES` edges into `data_intel_graph_edges` from `inferred_bom`. When `DISCOVERY_JOB_ID` is set, `discovery_jobs.result_count` is updated. Field mapping lives in `buildL1Row()` in that module.

## Discovery worker — CRM `crm-watch/emit` (B2)

`v8_discovery_worker.js` can call zhimao `POST /api/internal/crm-watch/emit` after a job succeeds (and optionally on failure). Configure `ZHIMAO_APP_URL` + `CRM_WATCH_EMIT_SECRET`, and set `DISCOVERY_COMPLETION_NOTIFY` to `emit` (HTTP only), `supabase` (legacy `notifications` insert only, default), or `both`. See `.env.example` and `v8_crm_watch_emit.js`.
