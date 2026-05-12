# V8 Pipeline Core — Zhimao Omni-Matrix

Multi-pillar B2B buyer discovery pipeline. Discovers overseas buyers via 6 parallel signal pillars, cleans through LLM intake, enriches with contact info via Playwright, deduplicates, and injects qualified leads into the Catagent main database.

## Pipeline Stages

```
Step 0  →  Geo-Orchestrator & Bilingual Dork Generator    (Gemini)
Step 1  →  Multi-Pillar Raw Collection                    (Serper / LBS / Tenders / Exhibitions)
Step 2  →  LLM Strict Entity Intake & CN-filter           (Gemini, batched)
Step 3  →  BOM Deduction + Playwright Contact Enrichment  (Gemini + Playwright)
Step 4  →  Global Dedupe & Schema Normalisation
Step 5  →  Routing Gateway → SQLite + Catagent API
```

## Quick Start

```bash
cp .env.example .env
# fill in GEMINI_KEY, SERPER_API_KEY, CATAGENT_API_URL, CATAGENT_API_KEY

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
| `CATAGENT_API_URL` | Yes | Catagent deployment URL |
| `CATAGENT_API_KEY` | Yes | Catagent internal API key (CRON_SECRET) |
| `USE_PROXY` | No | Set `true` to enable BrightData proxy in Step 3 |

## Catagent API Contract

Step 5 posts to `POST /api/data-intel/l1/procurement/bulk` with `{ items: BulkL1Item[] }`.
Each lead is mapped as:

| V8 field | BulkL1Item field |
|----------|-----------------|
| `company_name` | `name` |
| `country` | `country` |
| `domain` | `domain` |
| `primary_email` | `primary_email` |
| `primary_phone` | `primary_phone` |
| `inferred_bom` | `categories` |
| `entity_role` | `place_type` |
| `snippet` | `address_line` |
