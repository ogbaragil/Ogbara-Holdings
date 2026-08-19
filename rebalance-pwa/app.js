// Investment Rebalancing Assistant ("Allocate")
// All data lives in localStorage. Nothing is sent anywhere.
//
// Workflow: Portfolio shows where you are now (holdings). Strategy sets
// where you want to be (target allocation). Contribute is where you enter
// today's cash and constraints and generate a buy-only recommendation
// (greedy waterfall with partial funding - see generatePlan below).
// Existing holdings are never sold. A generated plan can be saved as
// Planned (recorded, portfolio untouched) or Completed (applied to
// holdings/cash) - see the Activity tab.

const STORAGE_KEY = 'rebalance-assistant-data-v3';

const PALETTE = ['#2563eb', '#7c3aed', '#16a34a', '#f59e0b', '#0891b2', '#db2777', '#4f46e5', '#ca8a04'];

const TICKER_NAMES = {
  VOO: 'Vanguard S&P 500 ETF',
  QQQ: 'Invesco QQQ Trust',
  SPY: 'SPDR S&P 500 ETF Trust',
  NVDA: 'NVIDIA Corporation',
  MSFT: 'Microsoft Corporation',
  GOOG: 'Alphabet Inc. Class C',
  GOOGL: 'Alphabet Inc. Class A',
  AAPL: 'Apple Inc.',
  AMZN: 'Amazon.com, Inc.',
  TSLA: 'Tesla, Inc.',
  META: 'Meta Platforms, Inc.',
  'AIR.PA': 'Airbus SE',
  CASH: 'Cash',
};

const DEFAULT_DATA = {
  targets: [
    { ticker: 'VOO', weight: 0.70 },
    { ticker: 'QQQ', weight: 0.19 },
    { ticker: 'NVDA', weight: 0.03 },
    { ticker: 'MSFT', weight: 0.03 },
    { ticker: 'AIR.PA', weight: 0.02 },
    { ticker: 'GOOG', weight: 0.03 },
  ],
  holdings: [
    { ticker: 'VOO', value: 26685 },
    { ticker: 'QQQ', value: 7535 },
    { ticker: 'MSFT', value: 867 },
    { ticker: 'NVDA', value: 1195 },
    { ticker: 'AIR.PA', value: 844 },
    { ticker: 'GOOG', value: 1194 },
  ],
  cash: 3018,
  maxTrades: 6,
  minTradeAmount: 0,
  roundTo: 0,
  currency: 'USD',
  allowIntentionalNewPositions: true,
  activity: [],
  lastUpdated: new Date().toISOString(),
};

const CURRENCIES = [
  { code: 'USD', label: 'US Dollar ($)' },
  { code: 'EUR', label: 'Euro (€)' },
  { code: 'GBP', label: 'British Pound (£)' },
  { code: 'CAD', label: 'Canadian Dollar (C$)' },
  { code: 'AUD', label: 'Australian Dollar (A$)' },
  { code: 'JPY', label: 'Japanese Yen (¥)' },
  { code: 'CHF', label: 'Swiss Franc (CHF)' },
  { code: 'INR', label: 'Indian Rupee (₹)' },
];

let state = loadState();
let currentPlan = null;
let activeTab = 'portfolio';
let planStep = 'recommend'; // 'recommend' | 'projected'

// Pushed-screen flags (layered on top of whatever tab is active). Exactly
// one of these should be true at a time; switchTab() resets all of them.
let inHoldingsEdit = false;
let inPreflight = false;
let inPlanRecommend = false;
let inPlanProjected = false;
let inConfirmView = false;
let confirmContext = null; // { source: 'plan' | 'activity', activityId: string|null, rows: [{ticker, recommended, actual}] }

// Draft copies used by the staged edit-then-save screens (Holdings, Strategy).
let holdingsDraft = null;
let targetsDraft = null;
let allowNewDraft = true;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.activity)) parsed.activity = [];
      // Migrate older activity entries (pre-Planned/Completed distinction) to the new shape.
      parsed.activity = parsed.activity.map(a => ({
        id: a.id || genId(),
        createdDate: a.createdDate || a.date || new Date().toISOString(),
        completedDate: a.completedDate !== undefined ? a.completedDate : (a.status === 'planned' ? null : (a.date || new Date().toISOString())),
        status: a.status || 'completed',
        buys: a.buys || [],
        totalInvested: typeof a.totalInvested === 'number' ? a.totalInvested : (a.buys || []).reduce((s, b) => s + b.amount, 0),
      }));
      if (typeof parsed.maxTrades !== 'number') parsed.maxTrades = parsed.targets ? parsed.targets.length : 6;
      if (typeof parsed.minTradeAmount !== 'number') parsed.minTradeAmount = 0;
      if (typeof parsed.roundTo !== 'number') parsed.roundTo = 0;
      if (typeof parsed.currency !== 'string') parsed.currency = 'USD';
      if (typeof parsed.allowIntentionalNewPositions !== 'boolean') parsed.allowIntentionalNewPositions = true;
      return parsed;
    }
  } catch (e) {
    console.error('Failed to load saved data, using defaults', e);
  }
  return structuredClone(DEFAULT_DATA);
}

function saveState() {
  state.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Formatting helpers ----------

function fmtMoney(n) {
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: state.currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
// Kept as an alias so any older call sites still work identically.
function fmtMoneyPrecise(n) {
  return fmtMoney(n);
}
function fmtPct(n) {
  return (n * 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '%';
}
function hashColor(ticker) {
  let h = 0;
  for (const c of ticker) h += c.charCodeAt(0);
  return PALETTE[h % PALETTE.length];
}
function tickerName(ticker) {
  return TICKER_NAMES[ticker.toUpperCase()] || ticker;
}
function initials(ticker) {
  return ticker.replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase() || '?';
}

// ---------- Derived data ----------

function holdingsTotal() {
  return state.holdings.reduce((s, r) => s + r.value, 0);
}
function holdingsMap() {
  return new Map(state.holdings.map(h => [h.ticker.toUpperCase(), h.value]));
}
function targetsMap() {
  return new Map(state.targets.map(t => [t.ticker.toUpperCase(), t.weight]));
}

// accuracy = 1 - (sum of |current% - target%|) / 2, evaluated over the union of tickers
function accuracyScore(valueByTicker, total) {
  if (total <= 0) return 0;
  const tMap = targetsMap();
  const tickers = new Set([...tMap.keys(), ...valueByTicker.keys()]);
  let sum = 0;
  tickers.forEach(tk => {
    const cur = (valueByTicker.get(tk) || 0) / total;
    const tgt = tMap.get(tk) || 0;
    sum += Math.abs(cur - tgt);
  });
  return Math.max(0, 1 - sum / 2);
}

// ---------- Validation ----------
// Duplicate tickers are dangerous here specifically because holdingsMap()/
// targetsMap() collapse arrays into Maps keyed by ticker - a duplicate
// silently overwrites the earlier entry. Rather than try to make every
// downstream calculation duplicate-safe, we simply never let a duplicate
// (or blank ticker, or negative value) reach the committed `state` in the
// first place: Holdings and Strategy are edited as drafts and can only be
// saved once they're clean.

function normTicker(ticker) {
  return (ticker || '').trim().toUpperCase();
}

function listHasDuplicates(list) {
  const seen = new Set();
  for (const row of list) {
    const t = normTicker(row.ticker);
    if (!t) continue;
    if (seen.has(t)) return true;
    seen.add(t);
  }
  return false;
}
function listHasBlank(list) {
  return list.some(row => !normTicker(row.ticker));
}
function listHasNegative(list, key) {
  return list.some(row => typeof row[key] === 'number' && row[key] < 0);
}

// Per-row error messages for the staged edit screens (Holdings/Strategy).
function computeRowErrors(list, valueKey) {
  const seen = new Map();
  return list.map((row, idx) => {
    const errors = [];
    const raw = (row.ticker || '').trim();
    const norm = raw.toUpperCase();
    if (!raw) {
      errors.push('Ticker required');
    } else if (seen.has(norm)) {
      errors.push('Duplicate ticker');
    } else {
      seen.set(norm, idx);
    }
    if (typeof row[valueKey] === 'number' && row[valueKey] < 0) {
      errors.push('Value cannot be negative');
    }
    return errors;
  });
}

function crossValidate(holdings, targets) {
  const hTickers = new Set(holdings.map(h => normTicker(h.ticker)).filter(Boolean));
  const tTickers = new Set(targets.map(t => normTicker(t.ticker)).filter(Boolean));
  return {
    holdingsWithoutTarget: [...hTickers].filter(t => !tTickers.has(t)),
    targetsWithoutHolding: [...tTickers].filter(t => !hTickers.has(t)),
  };
}

// Six granular pass/fail checks (mirrors the Pre-flight checklist) plus the
// two non-blocking cross-validation notes, all evaluated against the
// currently *committed* state (not drafts - drafts are validated locally
// within their own edit screens).
function computeValidation() {
  const targetsSum = state.targets.reduce((s, t) => s + (t.weight || 0), 0);
  const sumOk = Math.abs(targetsSum - 1) <= 0.001;
  const dupTargets = listHasDuplicates(state.targets);
  const dupHoldings = listHasDuplicates(state.holdings);
  const anyBlank = listHasBlank(state.targets) || listHasBlank(state.holdings);
  const anyNegative = listHasNegative(state.targets, 'weight') || listHasNegative(state.holdings, 'value');
  const cashOk = (state.cash || 0) > 0;
  const cross = crossValidate(state.holdings, state.targets);
  const needsAck = cross.targetsWithoutHolding.length > 0 && !state.allowIntentionalNewPositions;

  const checks = [
    { key: 'targetsSum', label: 'Targets equal 100%', pass: sumOk, detail: sumOk ? null : `Currently ${fmtPct(targetsSum)}` },
    { key: 'dupTargets', label: 'No duplicate target tickers', pass: !dupTargets },
    { key: 'dupHoldings', label: 'No duplicate holding tickers', pass: !dupHoldings },
    { key: 'blankTickers', label: 'No blank ticker symbols', pass: !anyBlank },
    { key: 'negativeValues', label: 'No negative values', pass: !anyNegative },
    { key: 'cashPositive', label: 'Cash greater than zero', pass: cashOk },
  ];
  if (needsAck) {
    checks.push({ key: 'newPositionsAck', label: 'New target positions acknowledged', pass: false, detail: 'Check "Allow intentional new positions" in Strategy' });
  }

  const blocking = checks.filter(c => !c.pass).map(c => c.label);

  return { checks, blocking, cross, targetsSum, sumOk, cashOk };
}

// ---------- Plan generation (greedy waterfall) ----------

// Buying any amount of an underweight ticker (without overshooting its target)
// reduces total tracking error by the same amount per dollar, regardless of
// which underweight ticker absorbs it. So the accuracy-maximizing move is
// simply: never leave cash idle while an underweight position could still
// use it. We rank by size of gap (so the biggest positions get fully funded
// first, minimizing the number of trades needed), but when cash runs short
// of fully closing a gap, we invest what's left rather than skipping it -
// then move on to the next (smaller-gap) candidate with whatever cash
// remains, subject to the max-trades and minimum-trade-amount settings.
function generatePlan() {
  const hTotal = holdingsTotal();
  const cash = state.cash || 0;
  const newTotal = hTotal + cash;
  const hMap = holdingsMap();
  const maxTrades = Math.max(1, state.maxTrades || state.targets.length);
  const minTrade = Math.max(0, state.minTradeAmount || 0);
  const roundTo = Math.max(0, state.roundTo || 0);

  const rows = state.targets.map(t => {
    const ticker = t.ticker.toUpperCase();
    const currentValue = hMap.get(ticker) || 0;
    const targetValue = t.weight * newTotal;
    const gap = targetValue - currentValue;
    return { ticker: t.ticker, currentValue, targetWeight: t.weight, gap };
  });

  const ranked = [...rows].filter(r => r.gap > 0.005).sort((a, b) => b.gap - a.gap);
  const eligible = ranked.slice(0, maxTrades);
  const overLimit = new Set(ranked.slice(maxTrades).map(r => r.ticker));

  let remaining = cash;
  const buys = new Map();
  const skipReason = new Map();

  eligible.forEach(r => {
    if (remaining <= 1e-9) {
      buys.set(r.ticker, 0);
      skipReason.set(r.ticker, 'cash');
      return;
    }
    const desiredRaw = Math.min(remaining, r.gap);
    const desired = roundTo > 0 ? Math.min(Math.floor(desiredRaw / roundTo) * roundTo, r.gap) : desiredRaw;
    if (desired > 1e-9 && desired >= minTrade - 1e-9) {
      buys.set(r.ticker, desired);
      remaining -= desired;
    } else {
      buys.set(r.ticker, 0);
      skipReason.set(r.ticker, 'mintrade');
    }
  });
  overLimit.forEach(tk => {
    buys.set(tk, 0);
    skipReason.set(tk, 'limit');
  });

  const planRows = rows.map(r => {
    const buy = buys.get(r.ticker) || 0;
    const partial = buy > 1e-9 && buy < r.gap - 1e-9;
    const projectedValue = r.currentValue + buy;
    const projectedWeight = newTotal > 0 ? projectedValue / newTotal : 0;
    const currentWeight = hTotal > 0 ? r.currentValue / hTotal : 0;
    let reason = null;
    if (r.gap <= 0.005) reason = 'attarget';
    else if (buy > 1e-9) reason = null; // funded (fully or partially) - no skip reason
    else if (skipReason.get(r.ticker) === 'cash') reason = 'cash';
    else if (skipReason.get(r.ticker) === 'limit') reason = 'limit';
    else if (skipReason.get(r.ticker) === 'mintrade') reason = 'mintrade';
    return { ...r, buy, partial, projectedValue, projectedWeight, currentWeight, reason };
  });

  planRows.sort((a, b) => b.gap - a.gap);

  const totalBought = planRows.reduce((s, r) => s + r.buy, 0);
  const leftover = Math.max(cash - totalBought, 0);
  const stillUnderweight = planRows.some(r => r.gap > 0.005 && r.buy <= 1e-9);

  const currentAccuracy = accuracyScore(hMap, hTotal);
  const projectedValueMap = new Map(planRows.map(r => [r.ticker.toUpperCase(), r.projectedValue]));
  const projectedAccuracy = accuracyScore(projectedValueMap, newTotal);

  return {
    rows: planRows,
    cash,
    totalBought,
    leftover,
    leftoverIsSurplus: leftover > 0.01 && !stillUnderweight,
    newTotal,
    hTotal,
    currentAccuracy,
    projectedAccuracy,
  };
}

// ---------- Navigation ----------

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.getElementById('view-' + id).hidden = false;
}

function switchTab(tab) {
  activeTab = tab;
  inHoldingsEdit = false;
  inPreflight = false;
  inPlanRecommend = false;
  inPlanProjected = false;
  inConfirmView = false;
  confirmContext = null;

  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (tab === 'strategy') {
    targetsDraft = state.targets.map(t => ({ ...t }));
    allowNewDraft = state.allowIntentionalNewPositions;
  }

  showView(tab);
  document.getElementById('backBtn').classList.toggle('visible', tab !== 'portfolio');
  renderAll();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('backBtn').addEventListener('click', () => {
  if (inConfirmView) { closeConfirmStep(); return; }
  if (inPlanProjected) {
    inPlanProjected = false;
    inPlanRecommend = true;
    showView('plan-recommend');
    renderRecommend();
    return;
  }
  if (inPlanRecommend) {
    inPlanRecommend = false;
    openPreflight();
    return;
  }
  if (inPreflight) { closePreflightBack(); return; }
  if (inHoldingsEdit) { closeHoldingsEdit(); return; }
  switchTab('portfolio');
});

// ---------- Render: Portfolio ----------

function renderPortfolio() {
  const hTotal = holdingsTotal();
  const cash = state.cash || 0;
  const total = hTotal + cash;
  // The headline number matches the donut chart's basis (invested holdings only).
  // Cash and the combined total are shown separately so the two never look inconsistent.
  document.getElementById('portfolioValue').textContent = fmtMoney(hTotal);
  document.getElementById('portfolioBreakdown').innerHTML = cash > 0
    ? `+ ${fmtMoney(cash)} available to invest &middot; <strong>${fmtMoney(total)} total</strong>`
    : `<strong>${fmtMoney(total)} total</strong> &middot; no cash available to invest`;
  document.getElementById('statCash').textContent = fmtMoney(cash);
  document.getElementById('statHoldings').textContent = state.holdings.length;

  const hMap = holdingsMap();
  const accuracy = accuracyScore(hMap, hTotal);
  document.getElementById('statAccuracy').textContent = fmtPct(accuracy);

  renderDonut(hTotal);

  const validation = computeValidation();
  const banner = document.getElementById('portfolioIssuesBanner');
  if (validation.blocking.length > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">&#9888; ${validation.blocking.length} issue${validation.blocking.length > 1 ? 's' : ''} to fix</div><div class="banner-sub">Resolve these so calculations stay accurate.</div><ul>${validation.blocking.map(b => `<li>${b}</li>`).join('')}</ul>`;
  } else {
    banner.hidden = true;
  }

  const tMap = targetsMap();
  const tbody = document.getElementById('portfolioHoldingsBody');
  tbody.innerHTML = '';
  state.holdings.forEach(h => {
    const weight = hTotal > 0 ? h.value / hTotal : 0;
    const target = tMap.get(h.ticker.toUpperCase()) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="ticker-cell"><span class="dot" style="background:${hashColor(h.ticker)}"></span>${h.ticker}</div></td>
      <td>${fmtMoney(h.value)}</td>
      <td>${fmtPct(weight)}</td>
      <td>${target ? fmtPct(target) : '—'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDonut(hTotal) {
  const svg = document.getElementById('donutChart');
  const legend = document.getElementById('donutLegend');
  svg.innerHTML = '';
  legend.innerHTML = '';

  const r = 50;
  const circumference = 2 * Math.PI * r;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', '60'); bg.setAttribute('cy', '60'); bg.setAttribute('r', r);
  bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', '#e5e9f0'); bg.setAttribute('stroke-width', '14');
  svg.appendChild(bg);

  let offset = 0;
  if (hTotal > 0) {
    state.holdings.forEach(h => {
      const frac = h.value / hTotal;
      if (frac <= 0) return;
      const len = frac * circumference;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '60'); circle.setAttribute('cy', '60'); circle.setAttribute('r', r);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', hashColor(h.ticker));
      circle.setAttribute('stroke-width', '14');
      circle.setAttribute('stroke-dasharray', `${len} ${circumference - len}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      svg.appendChild(circle);
      offset += len;

      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `
        <div class="left"><span class="dot" style="background:${hashColor(h.ticker)}"></span>${h.ticker}</div>
        <div>${fmtPct(frac)}</div>
      `;
      legend.appendChild(item);
    });
  }

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', '60'); label.setAttribute('y', '64');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('transform', 'rotate(90 60 60)');
  label.setAttribute('font-size', '14');
  label.setAttribute('font-weight', '700');
  label.setAttribute('fill', '#0f172a');
  label.textContent = state.holdings.length + (state.holdings.length === 1 ? ' Holding' : ' Holdings');
  svg.appendChild(label);
}

// ---------- Holdings edit (pushed screen from Portfolio) ----------

function openHoldingsEdit() {
  holdingsDraft = state.holdings.map(h => ({ ...h }));
  inHoldingsEdit = true;
  showView('holdings-edit');
  document.getElementById('backBtn').classList.add('visible');
  renderHoldingsEditView();
}

function closeHoldingsEdit() {
  inHoldingsEdit = false;
  holdingsDraft = null;
  switchTab('portfolio');
}

function saveHoldingsEdit() {
  const errors = computeRowErrors(holdingsDraft, 'value');
  if (errors.some(e => e.length > 0)) return;
  state.holdings = holdingsDraft.map(h => ({ ticker: normTicker(h.ticker), value: h.value }));
  saveState();
  closeHoldingsEdit();
}

// Lightweight update used while the user is actively typing in a holdings
// draft row. Unlike renderHoldingsEditView(), this never rebuilds the input
// elements themselves, so focus (and the on-screen keyboard on mobile) is
// never lost mid-keystroke. Full renderHoldingsEditView() is still used for
// the initial render and whenever rows are added/removed.
function updateHoldingsSummaryUI() {
  const errors = computeRowErrors(holdingsDraft, 'value');
  const totalIssues = errors.reduce((s, e) => s + e.length, 0);

  const banner = document.getElementById('holdingsBanner');
  if (totalIssues > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">&#9888; ${totalIssues} issue${totalIssues > 1 ? 's' : ''} to fix</div><div class="banner-sub">Resolve all issues to save your holdings.</div>`;
  } else {
    banner.hidden = true;
  }

  const rows = document.querySelectorAll('#holdingEditRows .row-edit-wrap');
  rows.forEach((wrap, idx) => {
    const row = holdingsDraft[idx];
    if (!row) return;
    const dot = wrap.querySelector('.ticker-dot');
    if (dot) dot.style.background = hashColor(row.ticker || '?');

    const rowErrors = errors[idx] || [];
    let errDiv = wrap.querySelector('.row-error');
    if (rowErrors.length) {
      if (!errDiv) {
        errDiv = document.createElement('div');
        errDiv.className = 'row-error';
        wrap.appendChild(errDiv);
      }
      errDiv.textContent = rowErrors.join(' · ');
    } else if (errDiv) {
      errDiv.remove();
    }
  });

  document.getElementById('holdingsEditTotal').textContent = fmtMoney(holdingsDraft.reduce((s, r) => s + (r.value || 0), 0));

  const saveBtn = document.getElementById('saveHoldingsBtn');
  saveBtn.disabled = totalIssues > 0;
  document.getElementById('saveHoldingsHint').hidden = totalIssues === 0;
}

function renderHoldingsEditView() {
  const errors = computeRowErrors(holdingsDraft, 'value');
  const totalIssues = errors.reduce((s, e) => s + e.length, 0);

  const banner = document.getElementById('holdingsBanner');
  if (totalIssues > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">&#9888; ${totalIssues} issue${totalIssues > 1 ? 's' : ''} to fix</div><div class="banner-sub">Resolve all issues to save your holdings.</div>`;
  } else {
    banner.hidden = true;
  }

  const container = document.getElementById('holdingEditRows');
  container.innerHTML = '';
  holdingsDraft.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = 'row-edit-wrap';
    const rowErrors = errors[idx];
    div.innerHTML = `
      <div class="row-edit">
        <span class="ticker-dot" style="background:${hashColor(row.ticker || '?')}"></span>
        <input type="text" value="${row.ticker}" data-idx="${idx}" class="holding-draft-ticker" placeholder="Ticker">
        <input type="number" step="0.01" value="${row.value}" data-idx="${idx}" class="holding-draft-value">
        <button class="row-delete" data-idx="${idx}" data-table="holding-draft">&times;</button>
      </div>
      ${rowErrors.length ? `<div class="row-error">${rowErrors.join(' · ')}</div>` : ''}
    `;
    container.appendChild(div);
  });
  document.getElementById('holdingsEditTotal').textContent = fmtMoney(holdingsDraft.reduce((s, r) => s + (r.value || 0), 0));

  const saveBtn = document.getElementById('saveHoldingsBtn');
  saveBtn.disabled = totalIssues > 0;
  document.getElementById('saveHoldingsHint').hidden = totalIssues === 0;
}

// ---------- Strategy (tab, staged draft) ----------

// Lightweight update used while the user is actively typing in a strategy
// draft row. See updateHoldingsSummaryUI() above for why this avoids
// rebuilding the input elements.
function updateStrategySummaryUI() {
  const rowErrors = computeRowErrors(targetsDraft, 'weight');
  const totalIssues = rowErrors.reduce((s, e) => s + e.length, 0);
  const sum = targetsDraft.reduce((s, t) => s + (t.weight || 0), 0);
  const sumOk = Math.abs(sum - 1) <= 0.001;

  const banner = document.getElementById('strategyBanner');
  if (totalIssues > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">&#9888; ${totalIssues} issue${totalIssues > 1 ? 's' : ''} to fix</div><div class="banner-sub">Resolve all issues to save your strategy.</div>`;
  } else if (!sumOk) {
    const remaining = (1 - sum) * 100;
    banner.hidden = false;
    banner.className = 'banner caution';
    banner.innerHTML = `<div class="banner-title">&#9888; Total = ${fmtPct(sum)}</div><div class="banner-sub">Targets must equal 100%. ${remaining >= 0 ? fmtPct(remaining / 100) + ' remaining' : fmtPct(-remaining / 100) + ' over'}</div>`;
  } else {
    banner.hidden = true;
  }

  const cross = crossValidate(state.holdings, targetsDraft);
  const noHoldingSet = new Set(cross.targetsWithoutHolding);

  const rows = document.querySelectorAll('#targetEditRows .row-edit-wrap');
  rows.forEach((wrap, idx) => {
    const row = targetsDraft[idx];
    if (!row) return;
    const dot = wrap.querySelector('.ticker-dot');
    if (dot) dot.style.background = hashColor(row.ticker || '?');

    const errs = [...(rowErrors[idx] || [])];
    const norm = normTicker(row.ticker);
    const noHolding = norm && noHoldingSet.has(norm) && !errs.length;

    let errDiv = wrap.querySelector('.row-error:not(.info)');
    if (errs.length) {
      if (!errDiv) {
        errDiv = document.createElement('div');
        errDiv.className = 'row-error';
        wrap.appendChild(errDiv);
      }
      errDiv.textContent = errs.join(' · ');
    } else if (errDiv) {
      errDiv.remove();
    }

    let infoDiv = wrap.querySelector('.row-error.info');
    if (noHolding) {
      if (!infoDiv) {
        infoDiv = document.createElement('div');
        infoDiv.className = 'row-error info';
        infoDiv.textContent = 'No current holding (allowed if intentional)';
        wrap.appendChild(infoDiv);
      }
    } else if (infoDiv) {
      infoDiv.remove();
    }
  });

  document.getElementById('targetTotal').textContent = fmtPct(sum);

  const saveBtn = document.getElementById('saveStrategyBtn');
  const canSave = totalIssues === 0 && sumOk;
  saveBtn.disabled = !canSave;
  document.getElementById('saveStrategyHint').hidden = canSave;
}

function renderStrategyView() {
  const rowErrors = computeRowErrors(targetsDraft, 'weight');
  const totalIssues = rowErrors.reduce((s, e) => s + e.length, 0);
  const sum = targetsDraft.reduce((s, t) => s + (t.weight || 0), 0);
  const sumOk = Math.abs(sum - 1) <= 0.001;

  const banner = document.getElementById('strategyBanner');
  if (totalIssues > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">&#9888; ${totalIssues} issue${totalIssues > 1 ? 's' : ''} to fix</div><div class="banner-sub">Resolve all issues to save your strategy.</div>`;
  } else if (!sumOk) {
    const remaining = (1 - sum) * 100;
    banner.hidden = false;
    banner.className = 'banner caution';
    banner.innerHTML = `<div class="banner-title">&#9888; Total = ${fmtPct(sum)}</div><div class="banner-sub">Targets must equal 100%. ${remaining >= 0 ? fmtPct(remaining / 100) + ' remaining' : fmtPct(-remaining / 100) + ' over'}</div>`;
  } else {
    banner.hidden = true;
  }

  const cross = crossValidate(state.holdings, targetsDraft);
  const noHoldingSet = new Set(cross.targetsWithoutHolding);

  const container = document.getElementById('targetEditRows');
  container.innerHTML = '';
  targetsDraft.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = 'row-edit-wrap';
    const errs = [...rowErrors[idx]];
    const norm = normTicker(row.ticker);
    const noHolding = norm && noHoldingSet.has(norm) && !errs.length;
    div.innerHTML = `
      <div class="row-edit">
        <span class="ticker-dot" style="background:${hashColor(row.ticker || '?')}"></span>
        <input type="text" value="${row.ticker}" data-idx="${idx}" class="target-draft-ticker" placeholder="Ticker">
        <input type="number" step="0.01" value="${(row.weight * 100).toFixed(2)}" data-idx="${idx}" class="target-draft-weight">
        <button class="row-delete" data-idx="${idx}" data-table="target-draft">&times;</button>
      </div>
      ${errs.length ? `<div class="row-error">${errs.join(' · ')}</div>` : ''}
      ${noHolding ? `<div class="row-error info">No current holding (allowed if intentional)</div>` : ''}
    `;
    container.appendChild(div);
  });

  document.getElementById('targetTotal').textContent = fmtPct(sum);
  document.getElementById('allowNewPositions').checked = allowNewDraft;

  const saveBtn = document.getElementById('saveStrategyBtn');
  const canSave = totalIssues === 0 && sumOk;
  saveBtn.disabled = !canSave;
  document.getElementById('saveStrategyHint').hidden = canSave;
}

function saveStrategy() {
  const rowErrors = computeRowErrors(targetsDraft, 'weight');
  const sum = targetsDraft.reduce((s, t) => s + (t.weight || 0), 0);
  if (rowErrors.some(e => e.length > 0) || Math.abs(sum - 1) > 0.001) return;
  state.targets = targetsDraft.map(t => ({ ticker: normTicker(t.ticker), weight: t.weight }));
  state.allowIntentionalNewPositions = allowNewDraft;
  saveState();
  switchTab('portfolio');
}

// Writes a numeric value into an input unless the user is currently typing
// in it — avoids resetting the caret to the end of the field mid-keystroke.
function setNumberValueUnlessFocused(id, value) {
  const el = document.getElementById(id);
  if (document.activeElement === el) return;
  el.value = value;
}

// ---------- Contribute (tab) ----------

function renderContribute() {
  setNumberValueUnlessFocused('cashInput', state.cash);
  setNumberValueUnlessFocused('maxTradesInput', state.maxTrades);
  setNumberValueUnlessFocused('minTradeInput', state.minTradeAmount);
  setNumberValueUnlessFocused('roundToInput', state.roundTo);

  const cashOk = (state.cash || 0) > 0;
  document.getElementById('cashError').textContent = cashOk ? '' : 'Enter an amount greater than 0.';

  const validation = computeValidation();
  const banner = document.getElementById('contributeBanner');
  const generateBtn = document.getElementById('generatePlanBtn');
  if (validation.blocking.length > 0) {
    banner.hidden = false;
    banner.className = 'banner error';
    banner.innerHTML = `<div class="banner-title">Issues to resolve before generating</div><ul>${validation.blocking.map(b => `<li>&#10005; ${b}</li>`).join('')}</ul>`;
    generateBtn.disabled = true;
    document.getElementById('generatePlanHint').hidden = false;
  } else {
    banner.hidden = true;
    generateBtn.disabled = false;
    document.getElementById('generatePlanHint').hidden = true;
  }
}

// ---------- Pre-flight check (pushed screen from Contribute) ----------

function openPreflight() {
  inPreflight = true;
  showView('preflight');
  document.getElementById('backBtn').classList.add('visible');
  renderPreflightView();
}

function closePreflightBack() {
  inPreflight = false;
  switchTab('contribute');
}

const WARNING_COPY = {
  holdingsWithoutTarget: {
    icon: 'info',
    label: 'Holding without corresponding target',
    detail: tickers => `${tickers.join(', ')} ${tickers.length > 1 ? "aren't" : "isn't"} part of your strategy, so ${tickers.length > 1 ? 'they' : 'it'} won't factor into target-based buys.`,
  },
  targetsWithoutHolding: {
    icon: 'neutral',
    label: 'Target without current holding',
    detail: tickers => `${tickers.join(', ')} will be purchased as new position${tickers.length > 1 ? 's' : ''} (allowed).`,
  },
};

function renderPreflightView() {
  const validation = computeValidation();
  const summary = document.getElementById('preflightSummary');
  if (validation.blocking.length === 0) {
    summary.className = 'banner good';
    summary.innerHTML = `<div class="banner-title">&#10003; Ready to generate</div><div class="banner-sub">Your setup looks good. Any notices are shown below.</div>`;
  } else {
    summary.className = 'banner error';
    summary.innerHTML = `<div class="banner-title">&#10005; ${validation.blocking.length} issue${validation.blocking.length > 1 ? 's' : ''} to fix</div><div class="banner-sub">Go back and resolve these first.</div>`;
  }

  const checksEl = document.getElementById('preflightChecks');
  checksEl.innerHTML = '';
  validation.checks.forEach(c => {
    const div = document.createElement('div');
    div.className = 'check-item';
    div.innerHTML = `
      <div class="check-icon ${c.pass ? 'pass' : 'fail'}">${c.pass ? '&#10003;' : '&#10005;'}</div>
      <div>
        <div class="check-label">${c.label}</div>
        ${c.detail ? `<div class="check-detail">${c.detail}</div>` : ''}
      </div>
    `;
    checksEl.appendChild(div);
  });

  const warningsEl = document.getElementById('preflightWarnings');
  warningsEl.innerHTML = '';
  ['holdingsWithoutTarget', 'targetsWithoutHolding'].forEach(key => {
    const tickers = validation.cross[key];
    if (!tickers || tickers.length === 0) return;
    const copy = WARNING_COPY[key];
    const div = document.createElement('div');
    div.className = 'check-item card';
    div.innerHTML = `
      <div class="check-icon ${copy.icon}">!</div>
      <div>
        <div class="check-label">${copy.label}</div>
        <div class="check-detail">${copy.detail(tickers)}</div>
      </div>
    `;
    warningsEl.appendChild(div);
  });

  document.getElementById('preflightGenerateBtn').disabled = validation.blocking.length > 0;
}

function proceedFromPreflight() {
  const validation = computeValidation();
  if (validation.blocking.length > 0) return;
  inPreflight = false;
  inPlanRecommend = true;
  currentPlan = generatePlan();
  planStep = 'recommend';
  showView('plan-recommend');
  document.getElementById('backBtn').classList.add('visible');
  renderRecommend();
}

// ---------- Render: Plan step 1 (Recommend) ----------

const SKIP_LABELS = {
  attarget: 'No purchase needed — already at or above target',
  cash: 'Not this round — no cash left to allocate',
  mintrade: 'Not this round — remaining cash is below your minimum trade amount',
  limit: 'Not this round — max trades limit reached',
};

function renderRecommend() {
  const plan = currentPlan || generatePlan();
  document.getElementById('recommendSubtitle').textContent =
    `Use your ${fmtMoney(plan.cash)} to move closer to target.`;

  const container = document.getElementById('recommendCards');
  container.innerHTML = '';
  plan.rows.forEach(r => {
    const skipped = r.buy <= 0;
    const pctOfCash = plan.cash > 0 ? r.buy / plan.cash : 0;
    const card = document.createElement('div');
    card.className = 'rec-card' + (skipped ? ' skipped' : '');
    const amountLabel = skipped ? '—' : fmtMoneyPrecise(r.buy) + (r.partial ? ' (partial)' : '');
    card.innerHTML = `
      <div class="rec-card-top">
        <div class="ticker-badge" style="background:${hashColor(r.ticker)}">${initials(r.ticker)}</div>
        <div class="rec-card-name">
          <div class="rec-card-ticker">${r.ticker}</div>
          <div class="rec-card-fullname">${tickerName(r.ticker)}</div>
        </div>
        <div>
          <div class="rec-card-amount">${amountLabel}</div>
          <div class="rec-card-pct">${skipped ? SKIP_LABELS[r.reason] : fmtPct(pctOfCash) + ' of cash'}</div>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${(pctOfCash * 100).toFixed(1)}%"></div></div>
    `;
    container.appendChild(card);
  });

  const skippedRows = plan.rows.filter(r => r.reason === 'cash' || r.reason === 'limit' || r.reason === 'mintrade');
  const callout = document.getElementById('skipCallout');
  if (skippedRows.length > 0) {
    const plural = skippedRows.length > 1;
    const names = skippedRows.map(r => r.ticker).join(' and ');
    let reasonText;
    if (skippedRows.every(r => r.reason === 'limit')) {
      reasonText = 'the max trades limit for this round has been reached.';
    } else if (skippedRows.every(r => r.reason === 'mintrade')) {
      reasonText = `the cash left over is below your minimum trade amount.`;
    } else {
      reasonText = `there isn’t enough cash left to fund ${plural ? 'them' : 'it'} this round.`;
    }
    callout.hidden = false;
    callout.innerHTML = `<strong>${names} ${plural ? 'are' : 'is'} skipped this round</strong><div>Because ${reasonText}</div>`;
  } else {
    callout.hidden = true;
  }

  document.getElementById('totalToInvest').textContent = fmtMoneyPrecise(plan.totalBought);
  const pctUsed = plan.cash > 0 ? plan.totalBought / plan.cash : 0;
  if (plan.leftover > 0.01) {
    document.getElementById('totalToInvestPct').textContent = plan.leftoverIsSurplus
      ? `${fmtPct(pctUsed)} of cash · ${fmtMoneyPrecise(plan.leftover)} left over (no positions need it)`
      : `${fmtPct(pctUsed)} of cash · ${fmtMoneyPrecise(plan.leftover)} left unallocated`;
  } else {
    document.getElementById('totalToInvestPct').textContent = `${fmtPct(pctUsed)} of cash`;
  }
}

// ---------- Render: Plan step 2 (Projected) ----------

function renderProjected() {
  const plan = currentPlan || generatePlan();
  document.getElementById('projectedSubtitle').textContent = `Comparison after investing ${fmtMoney(plan.totalBought)}`;

  const beforePct = plan.currentAccuracy;
  const afterPct = plan.projectedAccuracy;
  const improved = afterPct >= beforePct;
  const callout = document.getElementById('accuracyCallout');
  callout.className = 'info-callout' + (improved ? ' good' : '');
  callout.innerHTML = `
    <strong>${improved ? 'Closer to target' : 'Allocation change'}</strong>
    <div>Target accuracy ${improved ? 'improves' : 'moves'} from ${fmtPct(beforePct)} to ${fmtPct(afterPct)}</div>
  `;

  const tbody = document.getElementById('compareBody');
  tbody.innerHTML = '';
  plan.rows.forEach(r => {
    const currentPct = plan.hTotal > 0 ? r.currentValue / plan.hTotal : 0;
    const afterPctVal = r.projectedWeight;
    const targetVal = r.targetWeight;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="ticker-cell"><span class="dot" style="background:${hashColor(r.ticker)}"></span>${r.ticker}</div></td>
      <td>${fmtPct(targetVal)}</td>
      <td>${fmtPct(currentPct)}</td>
      <td>${fmtPct(afterPctVal)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('meaningCallout').innerHTML = `
    <strong>What this means</strong>
    <div>${plan.totalBought > 0
      ? 'Your portfolio is better aligned with your targets with minimal trades.'
      : 'No trades are recommended this round — your portfolio is already close to target.'}</div>
  `;
}

// ---------- Render: Activity ----------

function renderActivity() {
  const list = document.getElementById('activityList');
  const empty = document.getElementById('activityEmpty');
  list.innerHTML = '';
  if (!state.activity.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  [...state.activity].reverse().forEach(entry => {
    const d = new Date(entry.status === 'completed' && entry.completedDate ? entry.completedDate : entry.createdDate);
    const card = document.createElement('div');
    card.className = 'activity-card';
    const buysText = entry.buys.map(b => `${b.ticker} ${fmtMoneyPrecise(b.amount)}`).join(', ');
    const statusBadge = entry.status === 'planned'
      ? '<span class="activity-status planned">Planned</span>'
      : '<span class="activity-status completed">Completed</span>';
    const verb = entry.status === 'planned' ? 'Recommended' : 'Invested';
    card.innerHTML = `
      <div class="activity-date">${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${statusBadge}</div>
      <div class="activity-detail">${verb} ${fmtMoneyPrecise(entry.totalInvested)} — ${buysText}</div>
    `;
    if (entry.status === 'planned') {
      const btn = document.createElement('button');
      btn.className = 'link-btn';
      btn.textContent = 'Mark Completed';
      btn.addEventListener('click', () => {
        openConfirmStep(entry.buys.map(b => ({ ticker: b.ticker, amount: b.amount })), 'activity', entry.id);
      });
      card.appendChild(btn);
    }
    list.appendChild(card);
  });
}

// ---------- Confirm step (used both from a fresh Plan and from a saved-as-planned Activity entry) ----------

function openConfirmStep(rows, source, activityId) {
  inPlanRecommend = false;
  inPlanProjected = false;
  confirmContext = {
    source,
    activityId: activityId || null,
    rows: rows.map(r => ({ ticker: r.ticker, recommended: r.amount, actual: r.amount })),
  };
  renderConfirmStep();
  showView('plan-confirm');
  inConfirmView = true;
  document.getElementById('backBtn').classList.add('visible');
}

function closeConfirmStep() {
  inConfirmView = false;
  const source = confirmContext ? confirmContext.source : null;
  confirmContext = null;
  if (source === 'plan') {
    inPlanProjected = true;
    showView('plan-projected');
    document.getElementById('backBtn').classList.add('visible');
  } else {
    switchTab('activity');
  }
}

function renderConfirmStep() {
  const container = document.getElementById('confirmRows');
  container.innerHTML = '';
  confirmContext.rows.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'confirm-row';
    row.innerHTML = `
      <div class="ticker-badge" style="background:${hashColor(r.ticker)}">${initials(r.ticker)}</div>
      <div class="rec-card-name">
        <div class="rec-card-ticker">${r.ticker}</div>
        <div class="rec-recommend">Recommended ${fmtMoneyPrecise(r.recommended)}</div>
      </div>
      <input type="number" step="0.01" value="${r.actual.toFixed(2)}" data-confirm-idx="${idx}" class="confirm-actual">
    `;
    container.appendChild(row);
  });
  updateConfirmTotal();
}

function updateConfirmTotal() {
  const total = confirmContext.rows.reduce((s, r) => s + (r.actual || 0), 0);
  document.getElementById('confirmTotal').textContent = fmtMoneyPrecise(total);
}

function applyConfirmedPurchases() {
  const nonzero = confirmContext.rows.filter(r => r.actual > 0);
  if (nonzero.length === 0) {
    alert('Enter at least one purchase amount before confirming.');
    return;
  }
  nonzero.forEach(r => {
    const ticker = r.ticker.toUpperCase();
    const existing = state.holdings.find(h => h.ticker.toUpperCase() === ticker);
    if (existing) existing.value += r.actual;
    else state.holdings.push({ ticker: r.ticker, value: r.actual });
  });
  const totalInvested = nonzero.reduce((s, r) => s + r.actual, 0);
  state.cash = Math.max(0, (state.cash || 0) - totalInvested);

  if (confirmContext.source === 'activity' && confirmContext.activityId) {
    const entry = state.activity.find(a => a.id === confirmContext.activityId);
    if (entry) {
      entry.status = 'completed';
      entry.completedDate = new Date().toISOString();
      entry.buys = nonzero.map(r => ({ ticker: r.ticker, amount: r.actual }));
      entry.totalInvested = totalInvested;
    }
  } else {
    state.activity.push({
      id: genId(),
      createdDate: new Date().toISOString(),
      completedDate: new Date().toISOString(),
      status: 'completed',
      buys: nonzero.map(r => ({ ticker: r.ticker, amount: r.actual })),
      totalInvested,
    });
  }

  saveState();
  currentPlan = null;
  inConfirmView = false;
  confirmContext = null;
  switchTab('portfolio');
}

// ---------- Render: Settings ----------

function renderSettings() {
  const d = new Date(state.lastUpdated);
  document.getElementById('lastUpdated').textContent =
    'Last updated ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const select = document.getElementById('currencySelect');
  if (select.options.length === 0) {
    CURRENCIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.code;
      opt.textContent = c.label;
      select.appendChild(opt);
    });
  }
  select.value = state.currency || 'USD';
}

function renderAll() {
  renderPortfolio();
  if (activeTab === 'strategy' && targetsDraft) renderStrategyView();
  renderContribute();
  if (inPlanRecommend) renderRecommend();
  if (inPlanProjected) renderProjected();
  renderActivity();
  renderSettings();
}

// Uppercases an input's text in place, without touching the DOM node or
// losing the caret position (setting .value directly, unlike replacing the
// element via innerHTML, keeps focus intact).
function setUppercaseInPlace(input) {
  const upper = input.value.toUpperCase();
  if (upper === input.value) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = upper;
  if (start !== null && end !== null) {
    input.setSelectionRange(start, end);
  }
}

// ---------- Event wiring ----------

document.addEventListener('input', (e) => {
  const idx = e.target.dataset.idx;

  if (e.target.classList.contains('confirm-actual')) {
    const cIdx = parseInt(e.target.dataset.confirmIdx, 10);
    confirmContext.rows[cIdx].actual = parseFloat(e.target.value) || 0;
    updateConfirmTotal();
    return;
  }

  if (e.target.id === 'cashInput') {
    state.cash = parseFloat(e.target.value) || 0;
    saveState();
    renderContribute();
    return;
  }
  if (e.target.id === 'maxTradesInput') {
    state.maxTrades = Math.max(1, parseInt(e.target.value, 10) || state.targets.length);
    saveState();
    return;
  }
  if (e.target.id === 'minTradeInput') {
    state.minTradeAmount = Math.max(0, parseFloat(e.target.value) || 0);
    saveState();
    return;
  }
  if (e.target.id === 'roundToInput') {
    state.roundTo = Math.max(0, parseFloat(e.target.value) || 0);
    saveState();
    return;
  }
  if (idx === undefined) return;

  // Holdings edit screen (draft)
  if (e.target.classList.contains('holding-draft-ticker')) {
    setUppercaseInPlace(e.target);
    holdingsDraft[idx].ticker = e.target.value;
    updateHoldingsSummaryUI();
  } else if (e.target.classList.contains('holding-draft-value')) {
    holdingsDraft[idx].value = parseFloat(e.target.value) || 0;
    updateHoldingsSummaryUI();

  // Strategy screen (draft)
  } else if (e.target.classList.contains('target-draft-ticker')) {
    setUppercaseInPlace(e.target);
    targetsDraft[idx].ticker = e.target.value;
    updateStrategySummaryUI();
  } else if (e.target.classList.contains('target-draft-weight')) {
    targetsDraft[idx].weight = (parseFloat(e.target.value) || 0) / 100;
    updateStrategySummaryUI();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('row-delete')) {
    const idx = parseInt(e.target.dataset.idx, 10);
    const table = e.target.dataset.table;
    if (table === 'target-draft') {
      targetsDraft.splice(idx, 1);
      renderStrategyView();
    } else if (table === 'holding-draft') {
      holdingsDraft.splice(idx, 1);
      renderHoldingsEditView();
    }
  }
});

document.getElementById('addTargetRow').addEventListener('click', () => {
  targetsDraft.push({ ticker: '', weight: 0 });
  renderStrategyView();
});

document.getElementById('addHoldingRow').addEventListener('click', () => {
  holdingsDraft.push({ ticker: '', value: 0 });
  renderHoldingsEditView();
});

document.getElementById('allowNewPositions').addEventListener('change', (e) => {
  allowNewDraft = e.target.checked;
  renderStrategyView();
});

document.getElementById('openHoldingsEditBtn').addEventListener('click', openHoldingsEdit);
document.getElementById('saveHoldingsBtn').addEventListener('click', saveHoldingsEdit);
document.getElementById('saveStrategyBtn').addEventListener('click', saveStrategy);

document.getElementById('generatePlanBtn').addEventListener('click', () => {
  const validation = computeValidation();
  if (validation.blocking.length > 0) return;
  openPreflight();
});

document.getElementById('preflightGenerateBtn').addEventListener('click', proceedFromPreflight);

document.getElementById('reviewAllocationBtn').addEventListener('click', () => {
  inPlanRecommend = false;
  inPlanProjected = true;
  planStep = 'projected';
  showView('plan-projected');
  renderProjected();
});

document.getElementById('markCompletedBtn').addEventListener('click', () => {
  const plan = currentPlan || generatePlan();
  const nonzero = plan.rows.filter(r => r.buy > 0);
  if (nonzero.length === 0) {
    alert('No purchases in this plan yet — nothing to confirm.');
    return;
  }
  openConfirmStep(nonzero.map(r => ({ ticker: r.ticker, amount: r.buy })), 'plan', null);
});

document.getElementById('savePlannedBtn').addEventListener('click', () => {
  const plan = currentPlan || generatePlan();
  const nonzero = plan.rows.filter(r => r.buy > 0);
  if (nonzero.length === 0) {
    alert('No purchases in this plan yet — nothing to save.');
    return;
  }
  state.activity.push({
    id: genId(),
    createdDate: new Date().toISOString(),
    completedDate: null,
    status: 'planned',
    buys: nonzero.map(r => ({ ticker: r.ticker, amount: r.buy })),
    totalInvested: plan.totalBought,
  });
  saveState();
  currentPlan = null;
  switchTab('activity');
});

document.getElementById('discardPlanBtn').addEventListener('click', () => {
  currentPlan = null;
  switchTab('portfolio');
});

document.getElementById('confirmCompleteBtn').addEventListener('click', () => {
  applyConfirmedPurchases();
});

document.getElementById('cancelConfirmBtn').addEventListener('click', () => {
  closeConfirmStep();
});

// ---------- Settings actions ----------

document.getElementById('currencySelect').addEventListener('change', (e) => {
  state.currency = e.target.value;
  saveState();
  renderAll();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `allocate-data-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.targets || !imported.holdings) throw new Error('Missing targets/holdings');
      if (typeof imported.cash !== 'number') imported.cash = 0;
      if (!Array.isArray(imported.activity)) imported.activity = [];
      if (typeof imported.maxTrades !== 'number') imported.maxTrades = imported.targets.length;
      if (typeof imported.minTradeAmount !== 'number') imported.minTradeAmount = 0;
      if (typeof imported.roundTo !== 'number') imported.roundTo = 0;
      if (typeof imported.currency !== 'string') imported.currency = 'USD';
      if (typeof imported.allowIntentionalNewPositions !== 'boolean') imported.allowIntentionalNewPositions = true;
      state = imported;
      currentPlan = null;
      saveState();
      switchTab('portfolio');
    } catch (err) {
      alert('Could not import file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset all data back to the original defaults? This cannot be undone.')) return;
  state = structuredClone(DEFAULT_DATA);
  currentPlan = null;
  saveState();
  switchTab('portfolio');
});

// ---------- Init ----------

switchTab('portfolio');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.error('SW registration failed', err));
  });
}
