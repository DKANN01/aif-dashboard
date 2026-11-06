// AIF Portfolio Dashboard - renders data/portfolio.json produced by scripts/fetch_data.py

const CASH_SECTOR = "Cash & Equivalents";

const state = {
  rows: [],
  totals: null,
  sort: { key: "weight", dir: "desc" },
  sector: null,
  query: "",
};

/* ---------- formatting ---------- */

const usd = (v, digits = 2) =>
  v == null ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD",
    minimumFractionDigits: digits, maximumFractionDigits: digits });

const pct = (v, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

const signedPct = (v, digits = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

function bigMoney(v) {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return usd(v, 0);
}

// A P/E is only informative when earnings are positive and not vanishingly small.
const peMeaningful = (v) => v != null && v > 0 && v < 300;

const toneClass = (v) => (v == null ? "na" : v > 0 ? "up" : v < 0 ? "down" : "");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- load ---------- */

async function load() {
  const res = await fetch(`data/portfolio.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`portfolio.json returned ${res.status}`);
  const data = await res.json();

  state.totals = data.totals;

  state.rows = data.holdings.map((h) => ({
    ...h,
    pe: h.pe?.actual ?? null,
    peLabel: h.pe?.actual_label ?? null,
    peForward: h.pe?.forward ?? null,
    peForwardLabel: h.pe?.forward_label ?? null,
    isCash: false,
  }));

  state.rows.push({
    ticker: data.cash.ticker,
    name: data.cash.name,
    sector: CASH_SECTOR,
    industry: null,
    shares: null,
    price: 1,
    day_change_pct: null,
    market_value: data.cash.market_value,
    weight: data.cash.weight,
    return_1m: null,
    return_3m: null,
    return_ytd: null,
    pe: null,
    market_cap: null,
    isCash: true,
  });

  renderHeader(data);
  renderCards();
  renderSectors();
  renderTable();
}

/* ---------- header + cards ---------- */

function renderHeader(data) {
  const equity = data.holdings[0];
  document.getElementById("accountLine").textContent =
    `${data.account} · ${data.totals.position_count} equity positions + cash`;

  document.getElementById("asOf").textContent = equity?.trade_time ?? "—";

  const generated = new Date(data.generated_at);
  document.getElementById("positionsAsOf").textContent =
    `Share counts as of ${data.positions_as_of} · data pulled ${generated.toLocaleString("en-US")}`;

  document.getElementById("sourceLine").innerHTML =
    `<strong>Sources.</strong> Share counts: ${esc(data.positions_source)} ` +
    `Prices, market cap and sector: ${esc(data.price_source)}. ` +
    `P/E: Nasdaq analyst estimates endpoint.`;

  const ytd = equity?.basis_dates?.ytd;
  if (ytd) document.getElementById("ytdBase").textContent = `${ytd}`;
}

function renderCards() {
  const t = state.totals;
  const cards = [
    {
      label: "Total Account Value",
      value: usd(t.total_value, 0),
      note: `${usd(t.equity_value, 0)} equities · ${usd(t.cash_value, 0)} cash`,
    },
    {
      label: "Invested",
      value: pct(t.equity_weight),
      note: `${pct(t.cash_weight)} in cash`,
    },
    {
      label: "Equity Return · 1M",
      value: signedPct(t.equity_return_1m),
      note: "market-value weighted",
      tone: t.equity_return_1m,
    },
    {
      label: "Equity Return · 3M",
      value: signedPct(t.equity_return_3m),
      note: "market-value weighted",
      tone: t.equity_return_3m,
    },
    {
      label: "Equity Return · YTD",
      value: signedPct(t.equity_return_ytd),
      note: "market-value weighted",
      tone: t.equity_return_ytd,
    },
  ];

  document.getElementById("cards").innerHTML = cards
    .map(
      (c) => `<div class="card">
        <div class="card-label">${esc(c.label)}</div>
        <div class="card-value ${"tone" in c ? toneClass(c.tone) : ""}">${esc(c.value)}</div>
        <div class="card-note">${esc(c.note)}</div>
      </div>`
    )
    .join("");
}

/* ---------- sector bars ---------- */

function renderSectors() {
  const groups = new Map();
  for (const r of state.rows) {
    const key = r.sector ?? "Unclassified";
    const g = groups.get(key) ?? { weight: 0, value: 0, count: 0, isCash: r.isCash };
    g.weight += r.weight ?? 0;
    g.value += r.market_value ?? 0;
    g.count += 1;
    groups.set(key, g);
  }

  const rows = [...groups.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const max = Math.max(...rows.map(([, g]) => g.weight));

  document.getElementById("sectors").innerHTML = rows
    .map(
      ([name, g]) => `<div class="sector-row ${g.isCash ? "is-cash" : ""} ${
        state.sector === name ? "active" : ""
      }" data-sector="${esc(name)}" role="button" tabindex="0">
        <span class="sector-name">${esc(name)}</span>
        <span class="sector-track"><span class="sector-fill" style="width:${
          (g.weight / max) * 100
        }%"></span></span>
        <span class="sector-meta"><b>${pct(g.weight)}</b> · ${usd(g.value, 0)}</span>
      </div>`
    )
    .join("");

  for (const el of document.querySelectorAll(".sector-row")) {
    const pick = () => {
      state.sector = state.sector === el.dataset.sector ? null : el.dataset.sector;
      renderSectors();
      renderTable();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  }
}

/* ---------- table ---------- */

function visibleRows() {
  const q = state.query.trim().toLowerCase();
  let rows = state.rows.filter((r) => {
    if (state.sector && (r.sector ?? "Unclassified") !== state.sector) return false;
    if (!q) return true;
    return [r.ticker, r.name, r.sector, r.industry].some((f) =>
      String(f ?? "").toLowerCase().includes(q)
    );
  });

  const { key, dir } = state.sort;
  const flip = dir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    // Cash is a sleeve, not a pick - keep it pinned below the equities.
    if (a.isCash !== b.isCash) return a.isCash ? 1 : -1;

    const x = a[key];
    const y = b[key];
    if (typeof x === "string" || typeof y === "string") {
      return String(x ?? "").localeCompare(String(y ?? "")) * flip;
    }
    // Nulls (cash, missing P/E) always sort to the bottom.
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * flip;
  });

  return rows;
}

function renderTable() {
  const rows = visibleRows();
  const tbody = document.getElementById("tbody");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="11">No positions match this filter.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(rowHtml).join("");
  }

  renderFoot(rows);
  renderSortIndicators();

  const filter = document.getElementById("activeFilter");
  if (state.sector || state.query) {
    const bits = [];
    if (state.sector) bits.push(`sector <strong>${esc(state.sector)}</strong>`);
    if (state.query) bits.push(`search <strong>${esc(state.query)}</strong>`);
    filter.innerHTML = `Showing ${rows.length} of ${state.rows.length} rows — filtered by ${bits.join(" and ")}.`;
    filter.hidden = false;
  } else {
    filter.hidden = true;
  }
}

function rowHtml(r) {
  const peCell = peMeaningful(r.pe)
    ? `<span title="${esc(r.peLabel ?? "")}${
        r.peForward != null ? ` · ${esc(r.peForwardLabel)}: ${r.peForward.toFixed(1)}x` : ""
      }">${r.pe.toFixed(1)}x</span>`
    : `<span class="nm" title="${
        r.isCash ? "Not applicable" : "Negative or distorted earnings"
      }">${r.isCash ? "—" : "n/m"}</span>`;

  const shares = r.shares == null ? "" : `<span class="cname">${r.shares.toLocaleString("en-US", {
    maximumFractionDigits: 3,
  })} sh · ${esc(r.name)}</span>`;

  return `<tr class="${r.isCash ? "cash-row" : ""}">
    <td class="text"><span class="tick">${esc(r.ticker)}</span>${
      shares || `<span class="cname">${esc(r.name)}</span>`
    }</td>
    <td class="text sector-cell">${esc(r.sector ?? "Unclassified")}${
      r.industry ? `<small>${esc(r.industry)}</small>` : ""
    }</td>
    <td><span class="wcell"><span class="wbar"><i style="width:${
      (r.weight ?? 0) * 100 * 4
    }%"></i></span>${pct(r.weight)}</span></td>
    <td>${usd(r.price)}</td>
    <td class="${toneClass(r.day_change_pct)}">${
      r.day_change_pct == null ? "—" : signedPct(r.day_change_pct, 2)
    }</td>
    <td>${usd(r.market_value, 0)}</td>
    <td class="${toneClass(r.return_1m)}">${r.return_1m == null ? "—" : signedPct(r.return_1m)}</td>
    <td class="${toneClass(r.return_3m)}">${r.return_3m == null ? "—" : signedPct(r.return_3m)}</td>
    <td class="${toneClass(r.return_ytd)}">${r.return_ytd == null ? "—" : signedPct(r.return_ytd)}</td>
    <td>${peCell}</td>
    <td>${bigMoney(r.market_cap)}</td>
  </tr>`;
}

function renderFoot(rows) {
  const value = rows.reduce((s, r) => s + (r.market_value ?? 0), 0);
  const weight = rows.reduce((s, r) => s + (r.weight ?? 0), 0);

  // Weight each horizon by the market value of the rows that actually report it.
  const weighted = (key) => {
    const covered = rows.filter((r) => r[key] != null);
    const base = covered.reduce((s, r) => s + (r.market_value ?? 0), 0);
    if (!base) return null;
    return covered.reduce((s, r) => s + (r.market_value ?? 0) * r[key], 0) / base;
  };

  const peRows = rows.filter((r) => peMeaningful(r.pe) && r.market_value);
  const peBase = peRows.reduce((s, r) => s + r.market_value, 0);
  const wtdPe = peBase
    ? peRows.reduce((s, r) => s + r.market_value * r.pe, 0) / peBase
    : null;

  document.getElementById("tfoot").innerHTML = `<tr>
    <td class="text">Total · ${rows.length} row${rows.length === 1 ? "" : "s"}</td>
    <td class="text"></td>
    <td>${pct(weight)}</td>
    <td></td>
    <td></td>
    <td>${usd(value, 0)}</td>
    <td class="${toneClass(weighted("return_1m"))}">${signedPct(weighted("return_1m"))}</td>
    <td class="${toneClass(weighted("return_3m"))}">${signedPct(weighted("return_3m"))}</td>
    <td class="${toneClass(weighted("return_ytd"))}">${signedPct(weighted("return_ytd"))}</td>
    <td>${wtdPe == null ? "—" : `${wtdPe.toFixed(1)}x`}</td>
    <td></td>
  </tr>`;
}

function renderSortIndicators() {
  for (const th of document.querySelectorAll("th.sortable")) {
    th.classList.toggle("sorted", th.dataset.key === state.sort.key);
    th.classList.toggle("asc", th.dataset.key === state.sort.key && state.sort.dir === "asc");
    th.classList.toggle("desc", th.dataset.key === state.sort.key && state.sort.dir === "desc");
  }
}

/* ---------- wiring ---------- */

for (const th of document.querySelectorAll("th.sortable")) {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "desc" ? "asc" : "desc";
    } else {
      // Text columns read best A-Z; numbers read best biggest-first.
      state.sort = { key, dir: th.classList.contains("text") ? "asc" : "desc" };
    }
    renderTable();
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderTable();
});

document.getElementById("clearFilters").addEventListener("click", () => {
  state.sector = null;
  state.query = "";
  document.getElementById("search").value = "";
  renderSectors();
  renderTable();
});

load().catch((err) => {
  document.getElementById("accountLine").textContent =
    `Could not load data/portfolio.json — ${err.message}`;
  console.error(err);
});
