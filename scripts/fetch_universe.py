#!/usr/bin/env python3
"""Bake the searchable stock universe used by the portfolio construction tab.

A static GitHub Pages site cannot query a quote API from the browser: neither
Nasdaq nor Yahoo send an Access-Control-Allow-Origin header, so every live
fetch is blocked by CORS. Instead this script runs server-side (locally or in
Actions) and writes the data the page needs as plain JSON:

  data/universe.json          one compact search index of the top N companies
  data/detail/<TICKER>.json   per-name multiples plus the YTD close series

The page loads the index up front and lazily fetches one detail file whenever
the user clicks a position, which keeps the initial payload small.

Usage:
  python3 scripts/fetch_universe.py                 # top 750 + our holdings
  python3 scripts/fetch_universe.py --top 200       # smaller run, for testing
  python3 scripts/fetch_universe.py --only AAPL,MSFT
"""

import argparse
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSITIONS = ROOT / "data" / "positions.json"
INDEX_OUT = ROOT / "data" / "universe.json"
DETAIL_DIR = ROOT / "data" / "detail"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

SCREENER = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true"

# Non-common-equity lines that share the screener feed with ordinary stocks.
NON_EQUITY = re.compile(
    r"\b(warrant|unit|units|right|rights|preferred|depositary|debenture|"
    r"subordinated|note|notes)\b",
    re.I,
)

# Boilerplate on the end of Nasdaq security names - "Apple Inc. Common Stock".
NAME_TAIL = re.compile(
    r"\s+(?:Class\s+[A-Z]\s+)?(?:Ordinary Shares|Common Shares|Common Stock|"
    r"Capital Stock|Shares of Beneficial Interest|American Depositary Shares)"
    r"(?:\s+\(.*\))?\s*$",
    re.I,
)

print_lock = threading.Lock()


def log(*args):
    with print_lock:
        print(*args, flush=True)


def get_json(url, retries=4, backoff=1.5):
    """GET a JSON document, backing off on transient failures.

    Returns None on a 404 so a delisted or renamed ticker just gets skipped.
    """
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last = exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
        time.sleep(backoff * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def num(text):
    """'$286.34' / '29,375,758' / '(1,200)' / 'N/A' -> float or None."""
    if text is None:
        return None
    text = str(text).strip()
    if text in ("", "N/A", "--", "NA", "null"):
        return None
    cleaned = text.replace("$", "").replace(",", "").replace("%", "").strip()
    negative = cleaned.startswith("(") and cleaned.endswith(")")
    if negative:
        cleaned = cleaned[1:-1]
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return -value if negative else value


def api_symbol(symbol):
    """Screener writes share classes as BRK/B; the quote API wants BRK.B."""
    return symbol.strip().upper().replace("/", ".").replace("-", ".")


def clean_name(name):
    name = NAME_TAIL.sub("", name or "").strip()
    return re.sub(r"\s+", " ", name).rstrip(",")


def ratio(numerator, denominator):
    if numerator is None or not denominator:
        return None
    value = numerator / denominator
    # Guard against the absurd multiples that tiny or negative denominators give.
    return round(value, 2) if -10_000 < value < 10_000 else None


# ---------------------------------------------------------------- screener


def screener_rows():
    payload = get_json(SCREENER)
    rows = ((payload or {}).get("data") or {}).get("rows") or []
    if not rows:
        raise RuntimeError("screener returned no rows")

    out = []
    for row in rows:
        symbol = (row.get("symbol") or "").strip()
        name = row.get("name") or ""
        cap = num(row.get("marketCap"))
        if not symbol or not cap or cap <= 0:
            continue
        if "^" in symbol or NON_EQUITY.search(name):
            continue
        out.append(
            {
                "ticker": api_symbol(symbol),
                "name": clean_name(name),
                "sector": row.get("sector") or None,
                "industry": row.get("industry") or None,
                "market_cap": cap,
                "screener_price": num(row.get("lastsale")),
            }
        )

    out.sort(key=lambda r: r["market_cap"], reverse=True)

    # One company can list several share classes; keep only its largest.
    seen, deduped = set(), []
    for row in out:
        # Share classes are the only tickers carrying a suffix (BRK.A / BRK.B),
        # so collapsing on the stem keeps one line per company.
        key = (row["sector"], row["ticker"].split(".")[0])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


# ------------------------------------------------------------ per-ticker


def fetch_summary(ticker):
    payload = get_json(f"https://api.nasdaq.com/api/quote/{ticker}/summary?assetclass=stocks")
    fields = ((payload or {}).get("data") or {}).get("summaryData") or {}

    def field(key):
        value = (fields.get(key) or {}).get("value")
        # Nasdaq fills unknown fields with the literal string "N/A".
        return None if value in (None, "", "N/A", "--") else value

    return {
        "sector": field("Sector"),
        "industry": field("Industry"),
        "market_cap": num(field("MarketCap")),
        "previous_close": num(field("PreviousClose")),
        "div_yield": (num(field("Yield")) / 100) if num(field("Yield")) is not None else None,
        "range_52w": field("FiftTwoWeekHighLow"),
        "target_1y": num(field("OneYrTarget")),
    }


def fetch_quote(ticker):
    payload = get_json(f"https://api.nasdaq.com/api/quote/{ticker}/info?assetclass=stocks")
    primary = ((payload or {}).get("data") or {}).get("primaryData") or {}
    return {
        "price": num(primary.get("lastSalePrice")),
        "change_pct": num(primary.get("percentageChange")),
        "trade_time": primary.get("lastTradeTimestamp"),
    }


def fetch_history(ticker, from_date, to_date):
    url = (
        f"https://api.nasdaq.com/api/quote/{ticker}/historical"
        f"?assetclass=stocks&fromdate={from_date}&todate={to_date}&limit=600"
    )
    payload = get_json(url)
    rows = (((payload or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
    series = {}
    for row in rows:
        close = num(row.get("close"))
        if close is None:
            continue
        try:
            stamp = datetime.strptime(row["date"], "%m/%d/%Y").date()
        except (KeyError, ValueError):
            continue
        series[stamp.isoformat()] = round(close, 2)
    return dict(sorted(series.items()))


def fetch_pe(ticker):
    payload = get_json(f"https://api.nasdaq.com/api/analyst/{ticker}/peg-ratio", retries=2)
    data = (payload or {}).get("data") or {}
    chart = ((data.get("per") or {}).get("peRatioChart")) or []
    actual = next((p for p in chart if "Actual" in str(p.get("x", ""))), None)
    forward = next((p for p in chart if "Estimate" in str(p.get("x", ""))), None)
    return {
        "pe_trailing": actual.get("y") if actual else None,
        "pe_trailing_label": actual.get("x") if actual else None,
        "pe_forward": forward.get("y") if forward else None,
        "pe_forward_label": forward.get("x") if forward else None,
        "peg": (data.get("pegr") or {}).get("pegValue"),
    }


def table_lookup(table):
    """Map the first column of a Nasdaq financial table to its newest value.

    Nasdaq reports these statements in thousands.
    """
    out = {}
    for row in (table or {}).get("rows") or []:
        label = (row.get("value1") or "").strip()
        value = num(row.get("value2"))
        if label and value is not None:
            out[label] = value * 1000
    return out


def fetch_financials(ticker):
    payload = get_json(f"https://api.nasdaq.com/api/company/{ticker}/financials?frequency=1", retries=2)
    data = (payload or {}).get("data") or {}
    income = table_lookup(data.get("incomeStatementTable"))
    balance = table_lookup(data.get("balanceSheetTable"))
    period = ((data.get("incomeStatementTable") or {}).get("headers") or {}).get("value2")

    cash = (balance.get("Cash and Cash Equivalents") or 0) + (
        balance.get("Short-Term Investments") or 0
    )
    debt = (balance.get("Short-Term Debt / Current Portion of Long-Term Debt") or 0) + (
        balance.get("Long-Term Debt") or 0
    )

    return {
        "fiscal_period": period,
        "revenue": income.get("Total Revenue"),
        "gross_profit": income.get("Gross Profit"),
        "operating_income": income.get("Operating Income"),
        "net_income": income.get("Net Income"),
        "total_equity": balance.get("Total Equity"),
        "total_assets": balance.get("Total Assets"),
        "cash": cash or None,
        "debt": debt or None,
        "net_debt": (debt - cash) if (debt or cash) else None,
    }


# ------------------------------------------------------------- assembly


def close_on_or_before(series, target):
    """Most recent close at or before `target` (handles weekends and holidays)."""
    stamp = target.isoformat()
    candidates = [d for d in series if d <= stamp]
    if not candidates:
        return None
    return series[max(candidates)]


def months_back(anchor, months):
    index = anchor.month - 1 - months
    year = anchor.year + index // 12
    month = index % 12 + 1
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    last_day = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return date(year, month, min(anchor.day, last_day))


def pct_change(current, base):
    if current is None or not base:
        return None
    return round(current / base - 1, 6)


def build_detail(row, today, prior_year_end, window_start, overrides):
    """Fetch everything for one ticker and return its detail payload."""
    ticker = row["ticker"]

    info = fetch_summary(ticker)
    if not info["sector"] and info["market_cap"] is None:
        return None  # not a tradable common stock on this endpoint

    quote = fetch_quote(ticker)
    series = fetch_history(ticker, window_start, today.isoformat())
    pe = fetch_pe(ticker)
    fin = fetch_financials(ticker)

    price = quote["price"] or info["previous_close"] or row.get("screener_price")
    if price is None and series:
        price = series[max(series)]
    if price is None:
        return None

    cap = info["market_cap"] or row["market_cap"]
    enterprise = cap + fin["net_debt"] if (cap and fin["net_debt"] is not None) else cap

    multiples = {
        **pe,
        "ps": ratio(cap, fin["revenue"]),
        "pb": ratio(cap, fin["total_equity"]),
        "ev_sales": ratio(enterprise, fin["revenue"]),
        "ev_ebit": ratio(enterprise, fin["operating_income"]),
        "div_yield": info["div_yield"],
        "fiscal_period": fin["fiscal_period"],
    }

    margins = {
        "gross": ratio(fin["gross_profit"], fin["revenue"]),
        "operating": ratio(fin["operating_income"], fin["revenue"]),
        "net": ratio(fin["net_income"], fin["revenue"]),
        "roe": ratio(fin["net_income"], fin["total_equity"]),
    }

    # Only the year-to-date window goes to the browser; the extra lead-in days
    # exist so the YTD basis can fall on the last trading day of December.
    ytd_series = {d: c for d, c in series.items() if d >= prior_year_end.isoformat()}

    # Same rule fetch_data.py uses, so a holding is classified identically on
    # both tabs rather than showing as "Miscellaneous" on one of them.
    sector = info["sector"] or row["sector"]
    if overrides.get(ticker) and sector in (None, "Miscellaneous"):
        sector = overrides[ticker]

    returns = {
        "1m": pct_change(price, close_on_or_before(series, months_back(today, 1))),
        "3m": pct_change(price, close_on_or_before(series, months_back(today, 3))),
        "ytd": pct_change(price, close_on_or_before(series, prior_year_end)),
    }

    return {
        "ticker": ticker,
        "name": row["name"],
        "sector": sector,
        "industry": info["industry"] or row["industry"],
        "price": price,
        "day_change_pct": (quote["change_pct"] / 100) if quote["change_pct"] is not None else None,
        "market_cap": cap,
        "enterprise_value": enterprise,
        "trade_time": quote["trade_time"],
        "range_52w": info["range_52w"],
        "target_1y": info["target_1y"],
        "multiples": multiples,
        "margins": margins,
        "fundamentals": fin,
        "returns": returns,
        "ytd": {"dates": list(ytd_series), "closes": list(ytd_series.values())},
    }


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--top", type=int, default=750, help="how many companies by market cap")
    ap.add_argument("--only", help="comma-separated tickers, for a quick test run")
    ap.add_argument("--workers", type=int, default=6, help="concurrent requests")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    today = date.today()
    prior_year_end = date(today.year - 1, 12, 31)
    # A lead-in buffer guarantees a close on or before Dec 31 is in the window.
    window_start = (prior_year_end - timedelta(days=12)).isoformat()

    log("fetching screener ...")
    universe = screener_rows()
    log(f"screener: {len(universe)} common-equity lines with a market cap")

    targets = universe[: args.top]
    by_ticker = {r["ticker"]: r for r in targets}

    # Our own holdings must always be present, even if one falls out of the top N.
    positions = json.loads(POSITIONS.read_text())
    index = {r["ticker"]: r for r in universe}
    overrides = {
        api_symbol(p["ticker"]): p["sector_override"]
        for p in positions["equities"]
        if p.get("sector_override")
    }
    for pos in positions["equities"]:
        ticker = api_symbol(pos["ticker"])
        if ticker in by_ticker:
            continue
        row = index.get(ticker) or {
            "ticker": ticker,
            "name": pos["name"],
            "sector": pos.get("sector_override"),
            "industry": None,
            "market_cap": 0,
            "screener_price": None,
        }
        by_ticker[ticker] = row
        log(f"  + {ticker} (holding, outside top {args.top})")

    if args.only:
        wanted = {api_symbol(t) for t in args.only.split(",") if t.strip()}
        by_ticker = {
            t: by_ticker.get(t, index.get(t, {
                "ticker": t, "name": t, "sector": None, "industry": None,
                "market_cap": 0, "screener_price": None,
            }))
            for t in wanted
        }

    rows = list(by_ticker.values())
    cutoff = min((r["market_cap"] for r in targets), default=0)
    log(f"fetching {len(rows)} tickers (market-cap floor ${cutoff / 1e9:,.1f}B) ...")

    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    done = {"n": 0}
    skipped = []

    def work(row):
        try:
            detail = build_detail(row, today, prior_year_end, window_start, overrides)
        except RuntimeError as exc:
            detail = None
            log(f"  ! {row['ticker']}: {exc}")
        done["n"] += 1
        if done["n"] % 25 == 0:
            log(f"  {done['n']}/{len(rows)} ...")
        if detail is None:
            skipped.append(row["ticker"])
            return None
        path = DETAIL_DIR / f"{detail['ticker']}.json"
        path.write_text(json.dumps(detail, separators=(",", ":")) + "\n")
        return detail

    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        details = [d for d in pool.map(work, rows) if d]
    elapsed = time.time() - started

    details.sort(key=lambda d: d["market_cap"] or 0, reverse=True)

    # The index is an array of arrays purely to keep the download small; the
    # column order is published in "columns" so the page can stay readable.
    columns = ["ticker", "name", "sector", "industry", "market_cap", "price", "ytd", "pe"]
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Nasdaq public screener and quote APIs (api.nasdaq.com)",
        "top": args.top,
        "count": len(details),
        "market_cap_floor": cutoff,
        "columns": columns,
        "rows": [
            [
                d["ticker"],
                d["name"],
                d["sector"],
                d["industry"],
                d["market_cap"],
                d["price"],
                d["returns"]["ytd"],
                d["multiples"]["pe_trailing"],
            ]
            for d in details
        ],
    }

    keep = {d["ticker"] for d in details}

    if args.only:
        # A targeted run only refreshes the detail files it was asked for, so
        # it must not prune the rest of the universe or shrink the index.
        log(f"\n--only run: refreshed {len(keep)} detail file(s); left "
            f"{INDEX_OUT.relative_to(ROOT)} untouched")
        return

    # Keep stale detail files from piling up as the top N drifts over time.
    for path in DETAIL_DIR.glob("*.json"):
        if path.stem not in keep:
            path.unlink()

    INDEX_OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")

    detail_bytes = sum(p.stat().st_size for p in DETAIL_DIR.glob("*.json"))
    log(
        f"\nwrote {INDEX_OUT.relative_to(ROOT)} "
        f"({INDEX_OUT.stat().st_size / 1024:,.0f} KB, {len(details)} names)"
    )
    log(f"wrote {len(keep)} detail files ({detail_bytes / 1024 / 1024:,.1f} MB total)")
    log(f"elapsed {elapsed / 60:,.1f} min")
    if skipped:
        log(f"skipped {len(skipped)}: {', '.join(sorted(skipped)[:20])}")


if __name__ == "__main__":
    main(sys.argv[1:])
