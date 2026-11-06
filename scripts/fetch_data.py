#!/usr/bin/env python3
"""Refresh data/portfolio.json with live market data for the AIF portfolio.

Share counts come from data/positions.json (Fidelity 8/31/26 statement).
Prices, history, market cap and sector come from Nasdaq's public quote API.
P/E comes from Nasdaq's analyst peg-ratio endpoint.

Usage:  python3 scripts/fetch_data.py
"""

import json
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSITIONS = ROOT / "data" / "positions.json"
OUT = ROOT / "data" / "portfolio.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def get_json(url, retries=4):
    """GET a JSON document, backing off on transient failures."""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def money(text):
    """'$286.34' / '29,375,758,287' / 'N/A' -> float or None."""
    if not text or text in ("N/A", "--", ""):
        return None
    cleaned = text.replace("$", "").replace(",", "").replace("%", "").strip()
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    try:
        return float(cleaned)
    except ValueError:
        return None


def last_sale(ticker):
    data = get_json(f"https://api.nasdaq.com/api/quote/{ticker}/info?assetclass=stocks")
    primary = (data.get("data") or {}).get("primaryData") or {}
    return {
        "price": money(primary.get("lastSalePrice")),
        "change_pct": money(primary.get("percentageChange")),
        "trade_time": primary.get("lastTradeTimestamp"),
    }


def summary(ticker):
    data = get_json(f"https://api.nasdaq.com/api/quote/{ticker}/summary?assetclass=stocks")
    fields = (data.get("data") or {}).get("summaryData") or {}

    def field(key):
        return (fields.get(key) or {}).get("value")

    return {
        "sector": field("Sector"),
        "industry": field("Industry"),
        "market_cap": money(field("MarketCap")),
        "previous_close": money(field("PreviousClose")),
    }


def history(ticker, from_date, to_date):
    """Return {date: close} for the requested window, oldest first."""
    url = (
        f"https://api.nasdaq.com/api/quote/{ticker}/historical"
        f"?assetclass=stocks&fromdate={from_date}&todate={to_date}&limit=600"
    )
    data = get_json(url)
    rows = ((data.get("data") or {}).get("tradesTable") or {}).get("rows") or []
    series = {}
    for row in rows:
        close = money(row.get("close"))
        if close is None:
            continue
        stamp = datetime.strptime(row["date"], "%m/%d/%Y").date()
        series[stamp.isoformat()] = close
    return dict(sorted(series.items()))


def pe_ratio(ticker):
    """Latest reported fiscal-year P/E plus the next forward estimate."""
    try:
        data = get_json(f"https://api.nasdaq.com/api/analyst/{ticker}/peg-ratio", retries=2)
    except RuntimeError:
        return {"actual": None, "actual_label": None, "forward": None, "forward_label": None}
    chart = ((data.get("data") or {}).get("per") or {}).get("peRatioChart") or []
    actual = next((p for p in chart if "Actual" in str(p.get("x", ""))), None)
    forward = next((p for p in chart if "Estimate" in str(p.get("x", ""))), None)
    return {
        "actual": actual.get("y") if actual else None,
        "actual_label": actual.get("x") if actual else None,
        "forward": forward.get("y") if forward else None,
        "forward_label": forward.get("x") if forward else None,
    }


def close_on_or_before(series, target):
    """Most recent close at or before `target` (handles weekends/holidays)."""
    target = target.isoformat()
    candidates = [d for d in series if d <= target]
    if not candidates:
        return None, None
    key = max(candidates)
    return series[key], key


def months_back(anchor, months):
    """Calendar date `months` before `anchor`, clamping day-of-month overflow."""
    month_index = anchor.month - 1 - months
    year = anchor.year + month_index // 12
    month = month_index % 12 + 1
    day = min(anchor.day, [31, 29 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 28,
                           31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)


def pct_change(current, base):
    if current is None or base in (None, 0):
        return None
    return current / base - 1


def main():
    positions = json.loads(POSITIONS.read_text())
    today = date.today()
    prior_year_end = date(today.year - 1, 12, 31)
    window_start = (prior_year_end - timedelta(days=12)).isoformat()

    holdings = []
    for pos in positions["equities"]:
        ticker = pos["ticker"]
        print(f"fetching {ticker} ...", flush=True)
        quote = last_sale(ticker)
        info = summary(ticker)
        series = history(ticker, window_start, today.isoformat())
        multiple = pe_ratio(ticker)

        price = quote["price"] or info["previous_close"]
        if price is None and series:
            price = series[max(series)]

        sector, sector_source = info["sector"], "Nasdaq"
        if pos.get("sector_override") and (not sector or sector == "Miscellaneous"):
            sector, sector_source = pos["sector_override"], "override"

        base_1m, date_1m = close_on_or_before(series, months_back(today, 1))
        base_3m, date_3m = close_on_or_before(series, months_back(today, 3))
        base_ytd, date_ytd = close_on_or_before(series, prior_year_end)

        holdings.append({
            "ticker": ticker,
            "name": pos["name"],
            "shares": pos["shares"],
            "price": price,
            "market_value": round(price * pos["shares"], 2) if price else None,
            "day_change_pct": (quote["change_pct"] / 100) if quote["change_pct"] is not None else None,
            "return_1m": pct_change(price, base_1m),
            "return_3m": pct_change(price, base_3m),
            "return_ytd": pct_change(price, base_ytd),
            "basis_dates": {"1m": date_1m, "3m": date_3m, "ytd": date_ytd},
            "pe": multiple,
            "market_cap": info["market_cap"],
            "sector": sector,
            "sector_source": sector_source,
            "industry": info["industry"],
            "trade_time": quote["trade_time"],
        })
        time.sleep(1)

    cash = positions["cash"]
    cash_value = round(cash["shares"] * cash["nav"], 2)
    total = cash_value + sum(h["market_value"] or 0 for h in holdings)

    for h in holdings:
        h["weight"] = (h["market_value"] / total) if h["market_value"] else None

    holdings.sort(key=lambda h: h["market_value"] or 0, reverse=True)

    equity_value = total - cash_value
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "positions_as_of": positions["as_of"],
        "positions_source": positions["source"],
        "account": positions["account"],
        "price_source": "Nasdaq public quote API (api.nasdaq.com)",
        "totals": {
            "total_value": round(total, 2),
            "equity_value": round(equity_value, 2),
            "cash_value": cash_value,
            "cash_weight": cash_value / total,
            "equity_weight": equity_value / total,
            "position_count": len(holdings),
        },
        "cash": {
            "ticker": cash["ticker"],
            "name": cash["name"],
            "market_value": cash_value,
            "weight": cash_value / total,
        },
        "holdings": holdings,
    }

    # Portfolio-level returns: weight each holding's return by its market value.
    for horizon in ("return_1m", "return_3m", "return_ytd"):
        weighted = sum(
            (h["market_value"] or 0) * h[horizon] for h in holdings if h[horizon] is not None
        )
        covered = sum(h["market_value"] or 0 for h in holdings if h[horizon] is not None)
        payload["totals"][f"equity_{horizon}"] = weighted / covered if covered else None

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nwrote {OUT.relative_to(ROOT)}  |  {len(holdings)} positions  |  total ${total:,.2f}")


if __name__ == "__main__":
    main()
