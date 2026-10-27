# Project Instructions

## Overview
- BullishBharat is a single-page IPO/GMP dashboard. The frontend is `bullishbharat.html` with inline JavaScript, CSS, and Tailwind loaded from a CDN.
- `server.js` is a Node.js HTTP server using built-in modules only. Keep changes dependency-free unless a feature genuinely requires a package.
- The server fetches public NSE, Chittorgarh, and InvestorGain data on a best-effort basis; network or upstream failures should not prevent the local dashboard and its sample data from working.

## Run
- Requires Node.js 18 or newer.
- Start with `npm start` or `node server.js`. The default port is 3000; set `PORT` to choose another port. If occupied, the server tries the next port.
- `SITE_URL` can be set to the production base URL for canonical, sitemap, and robots URLs.

## Data and API
- `ipos.json` is an array of manual IPO records keyed by `id`. Manual fields override fetched fields for a matching ID.
- `gmp.json` is an object keyed by IPO `id`; its values (including `gmp` and history `h`) are the fallback for GMP. Matched live GMP values from InvestorGain override them and refresh with the server's 15-minute data cycle.
- IPO financials (period revenue and profit after tax) and pre/post-IPO shareholding are parsed from Chittorgarh detail pages when published; keep unavailable fields empty and preserve sample/manual data as fallback.
- IPO company summaries and issue-objective descriptions are read from Chittorgarh detail pages when published, with source/update metadata; preserve the existing sample/manual text when source content is unavailable.
- IPO strengths and risks are parsed from Chittorgarh company summaries when published; do not infer risk statements when none are provided, and retain manual/sample points only when no live key-point section is available.
- IPO industry sectors are resolved live from Chittorgarh's industry/sector reports; keep board type (`sec`/`cat`) separate from the company `sector` field.
- Prefer IPO-specific logos from Chittorgarh detail pages, then use the live InvestorGain IPO-list logo, and keep the manual/sample logo as the final fallback.
- Live QIB/NII/Retail/Total subscription figures are read from Chittorgarh subscription files for open IPOs, with fetched time/source in the API; keep any existing subscription data if the live source is unavailable.
- `events.json` is an array of calendar events with `date`, `title`, and optional `type` (defaults to `economic`). Keep all data files valid JSON.
- Closed IPOs with a valid closing date remain in the IPO API for 30 days after the close date, then are omitted. If a closed record has no parseable close date, keep it rather than removing it without a reliable expiry.
- The browser consumes `/api/ipos`, `/api/market`, `/api/events`, and `/api/indices` (index directory and constituents) plus `/api/indices/chart` (daily historical prices). Preserve existing response contracts and the frontend's sample-data fallback.
- Index constituent data comes from public Nifty Indices CSV files; company charts come from Yahoo Finance (5-minute intraday bars for 1D, daily bars for longer ranges) and must not be described as real-time. Show source failures and unavailable indices explicitly.

## Change and Verify
- Keep frontend changes compatible with the existing standalone HTML page and its inline script; there is no build step.
- After server or data changes, run `npm start` and smoke-check `/`, `/api/ipos`, `/api/market`, and `/api/events` as relevant. Stop the server after checking.
- `package.json` currently defines no test, lint, or build scripts. Do not claim these checks passed unless scripts are added and run.
