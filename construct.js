// Portfolio construction tab.
//
// Everything here runs against two pre-baked files written by
// scripts/fetch_universe.py: data/universe.json (the search index) and
// data/detail/<TICKER>.json (multiples plus the YTD close series, fetched
// lazily the first time a position is opened). The draft lives in
// localStorage so a work-in-progress survives a refresh.

const STORAGE_KEY = "aif.construct.draft.v1";
const MAX_SUGGESTIONS = 8;

const state = {
  universe: [],          // [{ticker, name, sector, industry, market_cap, price, ytd, pe}]
  byTicker: new Map(),
  draft: [],             // [{ticker, weight}] - weight is a percent, as typed
  current: null,         // holdings from the live dashboard, for "Load current"
  detail: new Map(),     // ticker -> detail payload (cache)
  highlight: -1,         // keyboard position in the suggestion list
};

/* ---------- formatting ---------- */

const pct = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);

const signedPct = (v, d = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

const usd = (v, d = 2) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        style: "currency", currency: "USD",
        minimumFractionDigits: d, maximumFractionDigits: d,
      });

function bigMoney(v) {
  if (v == null || v === 0) return "—";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  return usd(v, 0);
}

const mult = (v, d = 1) => (v == null ? "—" : `${v.toFixed(d)}x`);

// A P/E only informs when earnings are positive and not vanishingly small.
const peMeaningful = (v) => v != null && v > 0 && v < 300;

const toneClass = (v) => (v == null ? "na" : v > 0 ? "up" : v < 0 ? "down" : "");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- persistence ---------- */

function saveDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.draft));
  } catch {
    // A full or disabled localStorage must not break editing.
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((r) => r && typeof r.ticker === "string")
      .map((r) => ({ ticker: r.ticker, weight: Number(r.weight) || 0 }));
  } catch {
    return null;
  }
}

/* ---------- load ---------- */

async function load() {
  const [universe, portfolio] = await Promise.all([
    fetch(`data/universe.json?t=${Date.now()}`).then((r) => {
      if (!r.ok) throw new Error(`universe.json returned ${r.status}`);
      return r.json();
    }),
    // The dashboard feed is optional here - it only powers "Load current".
    fetch(`data/portfolio.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const cols = universe.columns;
  state.universe = universe.rows.map((row) => {
    const obj = {};
    cols.forEach((key, i) => (obj[key] = row[i]));
    obj.search = `${obj.ticker} ${obj.name}`.toLowerCase();
    return obj;
  });
  state.byTicker = new Map(state.universe.map((r) => [r.ticker, r]));
  state.current = portfolio;

  document.getElementById("universeCount").textContent =
    `${universe.count.toLocaleString("en-US")} names`;
  document.getElementById("universeAsOf").textContent =
    `Top ${universe.top} by market cap (floor ${bigMoney(universe.market_cap_floor)}) · ` +
    `refreshed ${new Date(universe.generated_at).toLocaleDateString("en-US")}`;

  document.getElementById("sourceLine").innerHTML =
    `<strong>Sources.</strong> ${esc(universe.source)} ` +
    `Prices and multiples are refreshed after the US close, not live.`;

  const saved = loadDraft();
  if (saved?.length) {
    state.draft = saved.filter((r) => state.byTicker.has(r.ticker));
    // A name can fall out of the top N between refreshes; say so rather than
    // letting it vanish from the draft silently.
    const dropped = saved.length - state.draft.length;
    document.getElementById("subLine").textContent =
      "Restored your saved draft — it is kept in this browser only." +
      (dropped ? ` ${dropped} name${dropped === 1 ? "" : "s"} left the universe and were removed.` : "");
  } else {
    seedFromCurrent();
    document.getElementById("subLine").textContent =
      "Seeded from the fund's current positions. Edits are saved in this browser.";
  }

  render();
}

function seedFromCurrent() {
  if (!state.current) {
    state.draft = [];
    return;
  }
  state.draft = state.current.holdings
    .filter((h) => state.byTicker.has(h.ticker))
    .map((h) => ({ ticker: h.ticker, weight: Number(((h.weight ?? 0) * 100).toFixed(2)) }));
}

/* ---------- detail fetch ---------- */

async function getDetail(ticker) {
  if (state.detail.has(ticker)) return state.detail.get(ticker);
  const res = await fetch(`data/detail/${encodeURIComponent(ticker)}.json`);
  if (!res.ok) throw new Error(`No detail file for ${ticker} (${res.status})`);
  const data = await res.json();
  state.detail.set(ticker, data);
  return data;
}

/* ---------- search ---------- */

// Users type BRK.B, BRK-B or BRKB for the same name; compare on letters only.
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function matches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const sq = squash(q);
  const held = new Set(state.draft.map((r) => r.ticker));

  const scored = [];
  for (const row of state.universe) {
    const ticker = squash(row.ticker);
    const name = row.name.toLowerCase();
    let score;
    if (ticker === sq) score = 0;
    else if (ticker.startsWith(sq)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 3;
    else if (ticker.includes(sq)) score = 4;
    else continue;
    // Already-held names sort last but stay visible, so it is obvious why
    // typing a current holding does not seem to do anything.
    scored.push({ row, score: score + (held.has(row.ticker) ? 10 : 0), held: held.has(row.ticker) });
  }

  scored.sort((a, b) => a.score - b.score || b.row.market_cap - a.row.market_cap);
  return scored.slice(0, MAX_SUGGESTIONS);
}

function renderSuggestions() {
  const input = document.getElementById("tickerSearch");
  const box = document.getElementById("suggestions");
  const hits = matches(input.value);

  if (!hits.length) {
    box.hidden = true;
    input.setAttribute("aria-expanded", "false");
    document.getElementById("searchHint").textContent = input.value.trim()
      ? `No match for "${input.value.trim()}" in the top ${state.universe.length} names by market cap.`
      : "";
    return;
  }

  document.getElementById("searchHint").textContent = "";
  box.innerHTML = hits
    .map(
      ({ row, held }, i) => `<div class="sg ${i === state.highlight ? "on" : ""} ${
        held ? "held" : ""
      }" data-ticker="${esc(row.ticker)}" role="option" aria-selected="${i === state.highlight}">
        <span class="sg-tick">${esc(row.ticker)}</span>
        <span class="sg-name">${esc(row.name)}</span>
        <span class="sg-sector">${esc(row.sector ?? "Unclassified")}</span>
        <span class="sg-cap">${bigMoney(row.market_cap)}</span>
        <span class="sg-add">${held ? "in portfolio" : "+ add"}</span>
      </div>`
    )
    .join("");
  box.hidden = false;
  input.setAttribute("aria-expanded", "true");

  for (const el of box.querySelectorAll(".sg")) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus in the input so typing can continue
      addPosition(el.dataset.ticker);
    });
  }
}

function addPosition(ticker) {
  const input = document.getElementById("tickerSearch");
  if (!state.byTicker.has(ticker)) return;

  if (!state.draft.some((r) => r.ticker === ticker)) {
    // Seed at 5%, or the existing average if that is smaller, so adding to an
    // already-full draft does not overshoot 100% by much.
    const total = draftTotal();
    const seed = state.draft.length ? Math.min(5, total / state.draft.length) : 5;
    state.draft.push({ ticker, weight: Number(seed.toFixed(2)) });
    saveDraft();
    render();
  }

  input.value = "";
  state.highlight = -1;
  renderSuggestions();
  flashRow(ticker);
}

function removePosition(ticker) {
  state.draft = state.draft.filter((r) => r.ticker !== ticker);
  saveDraft();
  render();
}

function flashRow(ticker) {
  const row = document.querySelector(`tr[data-ticker="${CSS.escape(ticker)}"]`);
  if (!row) return;
  row.classList.add("flash");
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => row.classList.remove("flash"), 900);
}

/* ---------- draft maths ---------- */

const draftTotal = () => state.draft.reduce((s, r) => s + (r.weight || 0), 0);

function draftRows() {
  return state.draft
    .map((r) => ({ ...state.byTicker.get(r.ticker), weight: r.weight }))
    .sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));
}

/** Weighted average of `key` over the rows that actually report it. */
function weightedBy(rows, key, usable = (v) => v != null) {
  const covered = rows.filter((r) => usable(r[key]) && r.weight > 0);
  const base = covered.reduce((s, r) => s + r.weight, 0);
  if (!base) return null;
  return covered.reduce((s, r) => s + r.weight * r[key], 0) / base;
}

/* ---------- render ---------- */

function render() {
  renderCards();
  renderDraftTable();
  renderDraftSectors();
}

function renderCards() {
  const rows = draftRows();
  const total = draftTotal();
  const cash = Math.max(0, 100 - total);

  const cards = [
    { label: "Positions", value: String(rows.length), note: `${cash.toFixed(1)}% unallocated` },
    {
      label: "Allocated",
      value: `${total.toFixed(1)}%`,
      note: total > 100.05 ? "over-allocated" : total < 99.95 ? "under-allocated" : "fully allocated",
    },
    {
      label: "Weighted P/E",
      value: mult(weightedBy(rows, "pe", peMeaningful)),
      note: `${rows.filter((r) => peMeaningful(r.pe)).length} of ${rows.length} with usable EPS`,
    },
    {
      label: "Weighted YTD",
      value: signedPct(weightedBy(rows, "ytd")),
      note: "if held at these weights since 12/31",
      tone: weightedBy(rows, "ytd"),
    },
    {
      label: "Weighted Mkt Cap",
      value: bigMoney(weightedBy(rows, "market_cap")),
      note: "target-weight average",
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

function renderDraftTable() {
  const rows = draftRows();
  const body = document.getElementById("draftBody");

  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="8">
      No positions yet — search above, or load the fund's current portfolio.</td></tr>`;
  } else {
    const max = Math.max(...rows.map((r) => r.weight || 0), 1);
    body.innerHTML = rows
      .map(
        (r) => `<tr data-ticker="${esc(r.ticker)}">
        <td class="text clickable" data-open="${esc(r.ticker)}">
          <span class="tick">${esc(r.ticker)}</span>
          <span class="cname">${esc(r.name)}</span>
        </td>
        <td class="text sector-cell clickable" data-open="${esc(r.ticker)}">${esc(
          r.sector ?? "Unclassified"
        )}${r.industry ? `<small>${esc(r.industry)}</small>` : ""}</td>
        <td>
          <span class="wedit">
            <span class="wbar"><i style="width:${((r.weight || 0) / max) * 100}%"></i></span>
            <input class="winput" type="number" min="0" max="100" step="0.25"
                   value="${r.weight}" data-weight="${esc(r.ticker)}"
                   aria-label="Target weight for ${esc(r.ticker)}">
            <span class="wpct">%</span>
          </span>
        </td>
        <td class="clickable" data-open="${esc(r.ticker)}">${usd(r.price)}</td>
        <td class="${toneClass(r.ytd)} clickable" data-open="${esc(r.ticker)}">${signedPct(r.ytd)}</td>
        <td class="clickable" data-open="${esc(r.ticker)}">${
          peMeaningful(r.pe) ? mult(r.pe) : '<span class="nm">n/m</span>'
        }</td>
        <td class="clickable" data-open="${esc(r.ticker)}">${bigMoney(r.market_cap)}</td>
        <td><button type="button" class="btn icon remove" data-remove="${esc(
          r.ticker
        )}" aria-label="Remove ${esc(r.ticker)}" title="Remove">&times;</button></td>
      </tr>`
      )
      .join("");
  }

  const total = draftTotal();
  document.getElementById("draftFoot").innerHTML = rows.length
    ? `<tr>
        <td class="text">Total · ${rows.length} position${rows.length === 1 ? "" : "s"}</td>
        <td class="text"></td>
        <td class="${Math.abs(total - 100) > 0.05 ? "down" : "up"}">${total.toFixed(2)}%</td>
        <td></td>
        <td class="${toneClass(weightedBy(rows, "ytd"))}">${signedPct(weightedBy(rows, "ytd"))}</td>
        <td>${mult(weightedBy(rows, "pe", peMeaningful))}</td>
        <td>${bigMoney(weightedBy(rows, "market_cap"))}</td>
        <td></td>
      </tr>`
    : "";

  const note = document.getElementById("weightNote");
  if (!rows.length) {
    note.textContent = "";
  } else if (Math.abs(total - 100) <= 0.05) {
    note.innerHTML = `<span class="ok">Fully allocated at 100.00%.</span>`;
  } else if (total > 100) {
    note.innerHTML = `<span class="warn">Over-allocated by ${(total - 100).toFixed(
      2
    )} pts</span> — trim a position or use <em>Normalize to 100%</em>.`;
  } else {
    note.innerHTML = `<span class="warn">${(100 - total).toFixed(
      2
    )} pts unallocated</span> — this would sit in cash.`;
  }

  wireRows();
}

function wireRows() {
  for (const input of document.querySelectorAll(".winput")) {
    input.addEventListener("change", () => {
      const ticker = input.dataset.weight;
      const entry = state.draft.find((r) => r.ticker === ticker);
      if (!entry) return;
      const value = Math.max(0, Math.min(100, Number(input.value) || 0));
      entry.weight = Number(value.toFixed(2));
      saveDraft();
      render();
    });
    // Re-rendering on every keystroke would steal focus mid-edit, so the row
    // only re-sorts on commit; Enter just blurs to trigger that.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  for (const btn of document.querySelectorAll("[data-remove]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removePosition(btn.dataset.remove);
    });
  }

  for (const cell of document.querySelectorAll("[data-open]")) {
    cell.addEventListener("click", () => openDrawer(cell.dataset.open));
  }
}

function renderDraftSectors() {
  const rows = draftRows();
  const groups = new Map();
  for (const r of rows) {
    const key = r.sector ?? "Unclassified";
    groups.set(key, (groups.get(key) ?? 0) + (r.weight || 0));
  }
  const cash = Math.max(0, 100 - draftTotal());
  if (cash > 0.005) groups.set("Cash & Equivalents", cash);

  const entries = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const host = document.getElementById("draftSectors");

  if (!entries.length) {
    host.innerHTML = `<p class="empty">Nothing allocated yet.</p>`;
    return;
  }

  const max = Math.max(...entries.map(([, w]) => w), 1);
  host.innerHTML = entries
    .map(
      ([name, w]) => `<div class="sector-row static ${
        name === "Cash & Equivalents" ? "is-cash" : ""
      }">
        <span class="sector-name">${esc(name)}</span>
        <span class="sector-track"><span class="sector-fill" style="width:${
          (w / max) * 100
        }%"></span></span>
        <span class="sector-meta"><b>${w.toFixed(1)}%</b></span>
      </div>`
    )
    .join("");
}

/* ---------- detail drawer ---------- */

async function openDrawer(ticker) {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const body = document.getElementById("drawerBody");
  const row = state.byTicker.get(ticker);

  document.getElementById("drawerTicker").textContent = ticker;
  document.getElementById("drawerName").textContent = row?.name ?? "";
  body.innerHTML = `<p class="empty">Loading ${esc(ticker)}&hellip;</p>`;
  drawer.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add("no-scroll");
  document.getElementById("drawerClose").focus();

  try {
    const d = await getDetail(ticker);
    body.innerHTML = drawerHtml(d);
  } catch (err) {
    body.innerHTML = `<p class="empty">Could not load details for ${esc(ticker)}.<br>
      <small>${esc(err.message)}</small></p>`;
  }
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  document.getElementById("drawerBackdrop").hidden = true;
  document.body.classList.remove("no-scroll");
}

function drawerHtml(d) {
  const m = d.multiples ?? {};
  const g = d.margins ?? {};
  const r = d.returns ?? {};

  const stat = (label, value, tone) =>
    `<div class="stat"><span class="stat-label">${esc(label)}</span>
      <span class="stat-value ${tone ?? ""}">${value}</span></div>`;

  // stat() escapes its label, so these are passed through raw.
  const peLabel = m.pe_trailing_label ? ` (${m.pe_trailing_label})` : "";
  const fwdLabel = m.pe_forward_label ? ` (${m.pe_forward_label})` : "";

  return `
    <div class="drawer-top">
      <div class="drawer-price">
        <span class="big">${usd(d.price)}</span>
        <span class="${toneClass(d.day_change_pct)}">${
          d.day_change_pct == null ? "" : signedPct(d.day_change_pct, 2) + " today"
        }</span>
      </div>
      <div class="drawer-tags">
        <span class="tag">${esc(d.sector ?? "Unclassified")}</span>
        ${d.industry ? `<span class="tag soft">${esc(d.industry)}</span>` : ""}
        <span class="tag soft">${bigMoney(d.market_cap)} cap</span>
      </div>
    </div>

    <h3>Price · Year to Date</h3>
    ${chartHtml(d)}

    <h3>Valuation Multiples</h3>
    <div class="stats">
      ${stat(`P/E${peLabel}`, peMeaningful(m.pe_trailing) ? mult(m.pe_trailing) : '<span class="nm">n/m</span>')}
      ${stat(`Forward P/E${fwdLabel}`, peMeaningful(m.pe_forward) ? mult(m.pe_forward) : '<span class="nm">n/m</span>')}
      ${stat("PEG", m.peg == null ? "—" : m.peg.toFixed(2))}
      ${stat("P/S", mult(m.ps))}
      ${stat("P/B", m.pb == null || m.pb <= 0 ? '<span class="nm">n/m</span>' : mult(m.pb))}
      ${stat("EV/Sales", mult(m.ev_sales))}
      ${stat("EV/EBIT", m.ev_ebit == null || m.ev_ebit <= 0 ? '<span class="nm">n/m</span>' : mult(m.ev_ebit))}
      ${stat("Dividend Yield", m.div_yield ? pct(m.div_yield, 2) : "—")}
    </div>

    <h3>Returns &amp; Margins</h3>
    <div class="stats">
      ${stat("1 Month", signedPct(r["1m"]), toneClass(r["1m"]))}
      ${stat("3 Month", signedPct(r["3m"]), toneClass(r["3m"]))}
      ${stat("Year to Date", signedPct(r.ytd), toneClass(r.ytd))}
      ${stat("52-Week Range", esc(d.range_52w ?? "—"))}
      ${stat("Gross Margin", pct(g.gross))}
      ${stat("Operating Margin", pct(g.operating))}
      ${stat("Net Margin", pct(g.net))}
      ${stat("Return on Equity", g.roe == null ? "—" : pct(g.roe))}
    </div>

    <h3>Scale</h3>
    <div class="stats">
      ${stat("Revenue", bigMoney(d.fundamentals?.revenue))}
      ${stat("Operating Income", bigMoney(d.fundamentals?.operating_income))}
      ${stat("Net Income", bigMoney(d.fundamentals?.net_income))}
      ${stat("Net Debt", d.fundamentals?.net_debt == null ? "—" : bigMoney(d.fundamentals.net_debt))}
      ${stat("Enterprise Value", bigMoney(d.enterprise_value))}
      ${stat("1-Yr Price Target", d.target_1y == null ? "—" : usd(d.target_1y, 0))}
    </div>

    <p class="drawer-foot">
      Fiscal year ended ${esc(m.fiscal_period ?? "—")}${
        d.trade_time ? ` · price as of ${esc(d.trade_time)}` : ""
      }.
    </p>`;
}

/** Hand-rolled SVG line chart - no chart library, so nothing to load. */
function chartHtml(d) {
  const dates = [...(d.ytd?.dates ?? [])];
  const closes = [...(d.ytd?.closes ?? [])];
  if (closes.length < 2) {
    return `<p class="empty">No year-to-date price history available.</p>`;
  }

  // The baked series stops at the last settled close, but the quote is newer.
  // Extending the line to the live price keeps the chart's YTD figure equal to
  // the one in the stats grid below it.
  const localToday = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  let liveTip = false;
  if (d.price != null && localToday > dates[dates.length - 1]) {
    dates.push(localToday);
    closes.push(d.price);
    liveTip = true;
  }

  const W = 640, H = 220, padL = 52, padR = 12, padT = 12, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  // A flat series would divide by zero; give it a nominal band instead.
  const span = hi - lo || hi * 0.02 || 1;
  const yPad = span * 0.08;
  const yMin = lo - yPad;
  const yMax = hi + yPad;

  const x = (i) => padL + (i / (closes.length - 1)) * innerW;
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const line = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(closes.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)}` +
    `L${padL},${(padT + innerH).toFixed(1)}Z`;

  const first = closes[0];
  const last = closes[closes.length - 1];
  const up = last >= first;
  const stroke = up ? "var(--up)" : "var(--down)";

  // Four horizontal guides, labelled in price terms.
  const guides = [0, 1, 2, 3]
    .map((k) => {
      const v = yMin + ((yMax - yMin) * k) / 3;
      const yy = y(v).toFixed(1);
      return `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="grid"/>
        <text x="${padL - 8}" y="${yy}" class="ylab">${usd(v, v >= 100 ? 0 : 2)}</text>`;
    })
    .join("");

  // Month boundaries give the x axis readable ticks without crowding.
  const ticks = [];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].slice(5, 7) !== dates[i - 1].slice(5, 7)) ticks.push(i);
  }
  const step = Math.ceil(ticks.length / 7) || 1;
  const xLabels = ticks
    .filter((_, k) => k % step === 0)
    .map((i) => {
      const [, mm] = dates[i].split("-");
      const label = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mm - 1];
      return `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="xlab">${label}</text>`;
    })
    .join("");

  const basisLine = `<line x1="${padL}" x2="${W - padR}" y1="${y(first).toFixed(1)}" y2="${y(
    first
  ).toFixed(1)}" class="basis"/>`;

  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img"
           aria-label="${esc(d.ticker)} price year to date, ${usd(first)} to ${usd(last)}">
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${stroke}" stop-opacity="0.26"/>
            <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${guides}
        ${basisLine}
        <path d="${area}" fill="url(#fill)"/>
        <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.8"
              stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(closes.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.2" fill="${stroke}"/>
        ${xLabels}
      </svg>
      <div class="chart-meta">
        <span>${esc(dates[0])} close <b>${usd(first)}</b></span>
        <span>${liveTip ? "latest" : `${esc(dates[dates.length - 1])} close`} <b>${usd(last)}</b></span>
        <span class="${toneClass(last / first - 1)}"><b>${signedPct(last / first - 1)}</b> ${
          // A name that listed mid-year has no prior year-end close to measure from.
          dates[0] < `${new Date().getFullYear()}-01-01` ? "YTD" : "since listing"
        }</span>
      </div>
    </div>`;
}

/* ---------- wiring ---------- */

const search = document.getElementById("tickerSearch");

search.addEventListener("input", () => {
  state.highlight = -1;
  renderSuggestions();
});

search.addEventListener("keydown", (e) => {
  const hits = matches(search.value);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!hits.length) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    state.highlight = (state.highlight + dir + hits.length) % hits.length;
    renderSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const pick = hits[state.highlight >= 0 ? state.highlight : 0];
    if (pick) addPosition(pick.row.ticker);
  } else if (e.key === "Escape") {
    search.value = "";
    state.highlight = -1;
    renderSuggestions();
  }
});

search.addEventListener("blur", () => {
  // Let a mousedown on a suggestion land before the list disappears.
  setTimeout(() => (document.getElementById("suggestions").hidden = true), 120);
});
search.addEventListener("focus", renderSuggestions);

document.getElementById("loadCurrent").addEventListener("click", () => {
  if (!state.current) return;
  seedFromCurrent();
  saveDraft();
  render();
  document.getElementById("subLine").textContent =
    "Reset to the fund's current positions and weights.";
});

document.getElementById("equalWeight").addEventListener("click", () => {
  if (!state.draft.length) return;
  const w = Number((100 / state.draft.length).toFixed(2));
  state.draft.forEach((r) => (r.weight = w));
  saveDraft();
  render();
});

document.getElementById("normalize").addEventListener("click", () => {
  const total = draftTotal();
  if (!total) return;
  state.draft.forEach((r) => (r.weight = Number(((r.weight / total) * 100).toFixed(2))));
  saveDraft();
  render();
});

document.getElementById("clearAll").addEventListener("click", () => {
  if (!state.draft.length) return;
  if (!confirm(`Remove all ${state.draft.length} positions from the draft?`)) return;
  state.draft = [];
  saveDraft();
  render();
});

document.getElementById("drawerClose").addEventListener("click", closeDrawer);
document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("drawer").hidden) closeDrawer();
});

load().catch((err) => {
  document.getElementById("subLine").textContent =
    `Could not load the stock universe — ${err.message}`;
  console.error(err);
});
