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
