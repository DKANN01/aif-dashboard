# AIF Portfolio Dashboard

A static, interactive dashboard for the AIF portfolio. Shows every
current position with its portfolio weight, 1M / 3M / YTD price return, P/E multiple, market cap
and sector.

No build step and no dependencies — it is plain HTML, CSS and JavaScript reading a JSON file, so
it deploys to GitHub Pages as-is.

```
index.html              dashboard markup
styles.css              styling
app.js                  rendering, sorting, filtering
data/positions.json     share counts  (input you maintain)
data/portfolio.json     market data   (generated — do not hand-edit)
scripts/fetch_data.py   refreshes data/portfolio.json
```

## Where the numbers come from

| Field | Source |
|---|---|
| Share counts | Fidelity statement, "Quantity Aug 31, 2026" column (`AIF - August 2026.pdf`) |
| Price, day change | Nasdaq quote API, real-time last sale |
| 1M / 3M / YTD returns | Nasdaq historical closes |
| Market cap, sector, industry | Nasdaq quote summary |
| P/E | Nasdaq analyst estimates endpoint, last reported fiscal year |

**Return definitions.** 1M and 3M compare the current price to the close on the nearest trading day
on or before one and three calendar months ago. YTD compares to the prior year-end close. All
returns are **price-only and exclude dividends**, so they will not tie exactly to the Fidelity
statement's total-return figures. Portfolio-level returns are the market-value-weighted average of
the equity positions and exclude the cash sleeve.

**P/E.** The last reported fiscal-year multiple. Positions with negative or distorted earnings show
`n/m` rather than a misleading number.

**One sector override.** Nasdaq classifies FERG as "Miscellaneous"; `data/positions.json` overrides
it to Industrials, matching the Refinitiv industry in the source workbook. The override is recorded
in that file and only applies when the upstream sector is missing or "Miscellaneous".

## Refreshing the data

```bash
python3 scripts/fetch_data.py
```

Rewrites `data/portfolio.json` using the share counts in `data/positions.json`. Takes about 30
seconds (it paces itself to stay inside Nasdaq's rate limits). Uses only the Python standard
library — no `pip install` required.

Commit the regenerated `data/portfolio.json` to publish the update.

### After a new monthly statement

Edit `data/positions.json`: update `as_of`, `source`, the `shares` figures, and the cash balance.
Add or remove entries from `equities` when positions are opened or closed. Then re-run the fetch
script.

### Automatic daily refresh

`.github/workflows/refresh.yml` re-runs the fetch script on weekday evenings and commits the result.
It needs **Settings → Actions → General → Workflow permissions → Read and write permissions**
enabled on the repo. Delete the workflow if you would rather refresh by hand.

## Running locally

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173. A plain file:// open will not work, because the page fetches
`data/portfolio.json` over HTTP.

## Deploying to GitHub Pages

```bash
git remote add origin git@github.com:<you>/aif-dashboard.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.

The repository must be public for Pages on a free account. Note that publishing makes the account's
holdings and share counts public — use a private repo with Pages enabled on a paid plan, or drop
`data/positions.json` down to tickers and weights only, if that is a concern.

## Caveats

- Nasdaq's public endpoints are undocumented and unauthenticated. They occasionally rate-limit;
  the fetch script retries with backoff, and a failed run leaves the previous `portfolio.json`
  intact.
- Historical closes are unadjusted for splits and dividends. A split during a lookback window would
  distort that position's return until the next refresh.
- The dashboard reads a committed snapshot rather than calling the market APIs from the browser,
  because those endpoints do not send CORS headers.
