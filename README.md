# AIF Portfolio Dashboard

A static, interactive site for the AIF portfolio, in two tabs:

- **Dashboard** — every current position with its portfolio weight, 1M / 3M / YTD price return,
  P/E multiple, market cap and sector.
- **Construct** — a scratchpad for the next portfolio. Add or drop names, type dollar amounts,
  search the top 750 US companies by market cap, and click any position to see its valuation
  multiples and a year-to-date price chart.

No build step and no dependencies — it is plain HTML, CSS and JavaScript reading JSON files, so
it deploys to GitHub Pages as-is.

```
index.html                  dashboard markup
construct.html              construction tab markup
styles.css                  styling for both tabs
app.js                      dashboard rendering, sorting, filtering
construct.js                draft editing, ticker search, detail drawer, YTD chart
data/positions.json         share counts     (input you maintain)
data/portfolio.json         holdings market data   (generated — do not hand-edit)
data/universe.json          search index, top 750 (generated — do not hand-edit)
data/detail/<TICKER>.json   per-name multiples + YTD closes (generated)
scripts/fetch_data.py       refreshes data/portfolio.json
scripts/fetch_universe.py   refreshes data/universe.json and data/detail/
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

## The Construct tab

You type the **dollars** going into each name. The **weight** column is that amount as a share of
the account, and whatever is not invested is carried as a cash line — at the bottom of the table
and as its own bar in the sector allocation — so the weights always add to 100% and read the same
way as the Dashboard tab. Put in more than the account holds and the cash line disappears in favour
of a warning naming the overdraw.

**Equal weight** spreads the invested dollars evenly across the current names, **Invest full
account** scales the draft proportionally until it uses the whole account value, and **Load current
portfolio** resets the draft to the fund's live positions at their market values.

The draft is saved to `localStorage` under `aif.construct.draft.v2`, so it survives a refresh or a
closed tab. It is **per-browser and never leaves the machine** — it is not shared between people
and is not committed to the repo.

**Why a fixed universe instead of live lookup.** The search box resolves against a pre-baked list
rather than calling a quote API, because no public market-data endpoint sends an
`Access-Control-Allow-Origin` header — Nasdaq's `OPTIONS` preflight replies with
`Access-Control-Allow-Methods: GET` and no origin header at all, so the browser blocks the request.
Public CORS proxies were not a viable workaround either. Everything is therefore fetched
server-side and committed.

The universe is the **top 750 US-listed companies by market cap** (a roughly $12B floor, which
comfortably covers the S&P 500 plus most of the mid-cap range), union the fund's own holdings so a
current position never disappears from search. Searching is ticker- and name-based and ignores
punctuation, so `BRK.B`, `BRK-B` and `brkb` all find Berkshire.

`data/universe.json` is about 90 KB and loads up front; the per-ticker detail files are about 5 KB
each and are fetched only when you click a position.

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

### Refreshing the stock universe

```bash
python3 scripts/fetch_universe.py              # top 750 + our holdings, ~20 minutes
python3 scripts/fetch_universe.py --top 100    # smaller run
python3 scripts/fetch_universe.py --only AAPL,MSFT
```

Rewrites `data/universe.json` and every file under `data/detail/`, and deletes detail files for
names that have dropped out of the top 750. It makes roughly 3,000 requests across six threads, so
give it about twenty minutes.

### Automatic refresh

| Workflow | Schedule | What it rewrites |
|---|---|---|
| `.github/workflows/refresh.yml` | weekday evenings | `data/portfolio.json` |
| `.github/workflows/refresh-universe.yml` | Saturdays | `data/universe.json`, `data/detail/` |

The universe job runs weekly rather than daily on purpose: it rewrites ~3.7 MB of detail files
each time, and committing that every day would bloat the repository history. Both workflows need
**Settings → Actions → General → Workflow permissions → Read and write permissions** enabled on
the repo. Delete either workflow if you would rather refresh by hand.

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
- The site reads committed snapshots rather than calling the market APIs from the browser,
  because those endpoints do not send CORS headers. Nothing on the page is live; prices are as of
  the last refresh.
- A few names have gaps in Nasdaq's own feed — Berkshire, for instance, comes back with no sector
  and shows as *Unclassified*. Share classes whose market cap is missing upstream (Brown-Forman)
  drop out of the market-cap ranking entirely.
- Multiples are computed from the last reported **fiscal year**, not trailing twelve months, so a
  company late in its fiscal year will look staler than its peers. `EV/EBIT` uses operating income
  as the EBIT proxy.
