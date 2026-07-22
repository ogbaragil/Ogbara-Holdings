// Investment Rebalancing Assistant ("Allocate")
// All data lives in localStorage. Nothing is sent anywhere.
//
// Workflow: set a target allocation, enter current holdings, enter cash
// available to invest, generate a buy-only recommendation (greedy
// waterfall: fully fund the most underweight ticker first, then the next,
// etc; a ticker is skipped - not partially funded - if there isn't enough
// cash left to fully close its gap, or if a max-trades limit is reached).
// Existing holdings are never sold. Saving a plan applies the buys to your
// holdings and logs the event under Activity.

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
  activity: [],
  lastUpdated: new Date().toISOString(),
};

let state = loadState();
let currentPlan = null;
let activeTab = 'portfolio';
let planStep = 'recommend'; // 'recommend' | 'projected'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.activity)) parsed.activity = [];
      if (typeof parsed.maxTrades !== 'number') parsed.maxTrades = parsed.targets ? parsed.targets.length : 6;
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
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtMoneyPrecise(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
function fmtPct(n, digits = 1) {
  return (n * 100).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%';
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

// ---------- Plan generation (greedy waterfall) ----------

function generatePlan() {
  const hTotal = holdingsTotal();
  const cash = state.cash || 0;
  const newTotal = hTotal + cash;
  const hMap = holdingsMap();
  const maxTrades = Math.max(1, state.maxTrades || state.targets.length);

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
    if (remaining >= r.gap - 1e-9) {
      buys.set(r.ticker, r.gap);
      remaining -= r.gap;
    } else {
      buys.set(r.ticker, 0);
      skipReason.set(r.ticker, 'cash');
    }
  });
  overLimit.forEach(tk => {
    buys.set(tk, 0);
    skipReason.set(tk, 'limit');
  });

  const planRows = rows.map(r => {
    const buy = buys.get(r.ticker) || 0;
    const projectedValue = r.currentValue + buy;
    const projectedWeight = newTotal > 0 ? projectedValue / newTotal : 0;
    const currentWeight = hTotal > 0 ? r.currentValue / hTotal : 0;
    let reason = null;
    if (r.gap <= 0.005) reason = 'attarget';
    else if (skipReason.get(r.ticker) === 'cash') reason = 'cash';
    else if (skipReason.get(r.ticker) === 'limit') reason = 'limit';
    return { ...r, buy, projectedValue, projectedWeight, currentWeight, reason };
  });

  planRows.sort((a, b) => b.gap - a.gap);

  const totalBought = planRows.reduce((s, r) => s + r.buy, 0);
  const leftover = Math.max(cash - totalBought, 0);

  const currentAccuracy = accuracyScore(hMap, hTotal);
  const projectedValueMap = new Map(planRows.map(r => [r.ticker.toUpperCase(), r.projectedValue]));
  const projectedAccuracy = accuracyScore(projectedValueMap, newTotal);

  return {
    rows: planRows,
    cash,
    totalBought,
    leftover,
    newTotal,
    hTotal,
    currentAccuracy,
    projectedAccuracy,
  };
}

// ---------- Navigation ----------

function switchTab(tab) {
  activeTab = tab;
  if (tab === 'plan') planStep = currentPlan ? planStep : 'recommend';
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (tab === 'plan') {
    if (!currentPlan) currentPlan = generatePlan();
    if (planStep === 'recommend') document.getElementById('view-plan-recommend').hidden = false;
    else document.getElementById('view-plan-projected').hidden = false;
  } else {
    document.getElementById('view-' + tab).hidden = false;
  }

  document.getElementById('backBtn').classList.toggle('visible', tab !== 'portfolio');
  renderAll();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('backBtn').addEventListener('click', () => {
  if (activeTab === 'plan' && planStep === 'projected') {
    planStep = 'recommend';
    renderAll();
    document.getElementById('view-plan-projected').hidden = true;
    document.getElementById('view-plan-recommend').hidden = false;
    return;
  }
  switchTab('portfolio');
});

// ---------- Render: Portfolio ----------

function renderPortfolio() {
  const hTotal = holdingsTotal();
  const total = hTotal + (state.cash || 0);
  document.getElementById('portfolioValue').textContent = fmtMoney(total);
  document.getElementById('statCash').textContent = fmtMoney(state.cash || 0);
  document.getElementById('statHoldings').textContent = state.holdings.length;

  const hMap = holdingsMap();
  const accuracy = accuracyScore(hMap, hTotal);
  document.getElementById('statAccuracy').textContent = fmtPct(accuracy, 0);

  renderDonut(hTotal);

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

// ---------- Render: Targets ----------

function renderTargets() {
  const container = document.getElementById('targetRows');
  container.innerHTML = '';
  state.targets.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = 'row-edit';
    div.innerHTML = `
      <span class="ticker-dot" style="background:${hashColor(row.ticker || '?')}"></span>
      <input type="text" value="${row.ticker}" data-idx="${idx}" class="target-ticker" placeholder="Ticker">
      <input type="number" step="0.01" value="${(row.weight * 100).toFixed(2)}" data-idx="${idx}" class="target-weight">
      <button class="row-delete" data-idx="${idx}" data-table="target">&times;</button>
    `;
    container.appendChild(div);
  });

  const total = state.targets.reduce((s, r) => s + r.weight, 0);
  document.getElementById('targetTotal').textContent = fmtPct(total);
  const warning = document.getElementById('targetWarning');
  warning.textContent = Math.abs(total - 1) > 0.001
    ? `Target weights sum to ${fmtPct(total)}, not 100%.`
    : '';

  document.getElementById('cashInput').value = state.cash;
  document.getElementById('maxTradesInput').value = state.maxTrades;

  const hContainer = document.getElementById('holdingRows');
  hContainer.innerHTML = '';
  state.holdings.forEach((row, idx) => {
    const div = document.createElement('div');
    div.className = 'row-edit';
    div.innerHTML = `
      <span class="ticker-dot" style="background:${hashColor(row.ticker || '?')}"></span>
      <input type="text" value="${row.ticker}" data-idx="${idx}" class="holding-ticker" placeholder="Ticker">
      <input type="number" step="0.01" value="${row.value}" data-idx="${idx}" class="holding-value">
      <button class="row-delete" data-idx="${idx}" data-table="holding">&times;</button>
    `;
    hContainer.appendChild(div);
  });
  document.getElementById('holdingsTotal').textContent = fmtMoney(holdingsTotal());
}

// ---------- Render: Plan step 1 (Recommend) ----------

const SKIP_LABELS = {
  attarget: 'No purchase needed — already at or above target',
  cash: 'Not this round — not enough cash left to fully fund this position',
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
    card.innerHTML = `
      <div class="rec-card-top">
        <div class="ticker-badge" style="background:${hashColor(r.ticker)}">${initials(r.ticker)}</div>
        <div class="rec-card-name">
          <div class="rec-card-ticker">${r.ticker}</div>
          <div class="rec-card-fullname">${tickerName(r.ticker)}</div>
        </div>
        <div>
          <div class="rec-card-amount">${skipped ? '—' : fmtMoneyPrecise(r.buy)}</div>
          <div class="rec-card-pct">${skipped ? SKIP_LABELS[r.reason] : fmtPct(pctOfCash, 1) + ' of cash'}</div>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${(pctOfCash * 100).toFixed(1)}%"></div></div>
    `;
    container.appendChild(card);
  });

  const skippedRows = plan.rows.filter(r => r.reason === 'cash' || r.reason === 'limit');
  const callout = document.getElementById('skipCallout');
  if (skippedRows.length > 0) {
    const plural = skippedRows.length > 1;
    const names = skippedRows.map(r => r.ticker).join(' and ');
    const reasonText = skippedRows.every(r => r.reason === 'limit')
      ? `the max trades limit for this round has been reached.`
      : `there isn’t enough cash left to fully fund ${plural ? 'them' : 'it'} this round.`;
    callout.hidden = false;
    callout.innerHTML = `<strong>${names} ${plural ? 'are' : 'is'} skipped this round</strong><div>Because ${reasonText}</div>`;
  } else {
    callout.hidden = true;
  }

  document.getElementById('totalToInvest').textContent = fmtMoneyPrecise(plan.totalBought);
  const pctUsed = plan.cash > 0 ? plan.totalBought / plan.cash : 0;
  document.getElementById('totalToInvestPct').textContent =
    plan.leftover > 0.01
      ? `${fmtPct(pctUsed, 0)} of cash · ${fmtMoneyPrecise(plan.leftover)} left unallocated`
      : `${fmtPct(pctUsed, 0)} of cash`;
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
    <div>Target accuracy ${improved ? 'improves' : 'moves'} from ${fmtPct(beforePct, 0)} to ${fmtPct(afterPct, 0)}</div>
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
    const d = new Date(entry.date);
    const card = document.createElement('div');
    card.className = 'activity-card';
    const buysText = entry.buys.map(b => `${b.ticker} ${fmtMoneyPrecise(b.amount)}`).join(', ');
    card.innerHTML = `
      <div class="activity-date">${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div>
      <div class="activity-detail">Invested ${fmtMoneyPrecise(entry.totalInvested)} — ${buysText}</div>
    `;
    list.appendChild(card);
  });
}

// ---------- Render: Settings ----------

function renderSettings() {
  const d = new Date(state.lastUpdated);
  document.getElementById('lastUpdated').textContent =
    'Last updated ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function renderAll() {
  renderPortfolio();
  renderTargets();
  renderRecommend();
  renderProjected();
  renderActivity();
  renderSettings();
}

// ---------- Event wiring: Targets inputs ----------

document.addEventListener('input', (e) => {
  const idx = e.target.dataset.idx;

  if (e.target.id === 'cashInput') {
    state.cash = parseFloat(e.target.value) || 0;
    saveState();
    return;
  }
  if (e.target.id === 'maxTradesInput') {
    state.maxTrades = Math.max(1, parseInt(e.target.value, 10) || state.targets.length);
    saveState();
    return;
  }
  if (idx === undefined) return;

  if (e.target.classList.contains('target-ticker')) {
    state.targets[idx].ticker = e.target.value.toUpperCase();
    saveState();
  } else if (e.target.classList.contains('target-weight')) {
    state.targets[idx].weight = (parseFloat(e.target.value) || 0) / 100;
    saveState();
    const total = state.targets.reduce((s, r) => s + r.weight, 0);
    document.getElementById('targetTotal').textContent = fmtPct(total);
    const warning = document.getElementById('targetWarning');
    warning.textContent = Math.abs(total - 1) > 0.001 ? `Target weights sum to ${fmtPct(total)}, not 100%.` : '';
  } else if (e.target.classList.contains('holding-ticker')) {
    state.holdings[idx].ticker = e.target.value.toUpperCase();
    saveState();
  } else if (e.target.classList.contains('holding-value')) {
    state.holdings[idx].value = parseFloat(e.target.value) || 0;
    saveState();
    document.getElementById('holdingsTotal').textContent = fmtMoney(holdingsTotal());
  }
});

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('row-delete')) {
    const idx = parseInt(e.target.dataset.idx, 10);
    const table = e.target.dataset.table;
    if (table === 'target') state.targets.splice(idx, 1);
    else state.holdings.splice(idx, 1);
    saveState();
    renderTargets();
  }
});

document.getElementById('addTargetRow').addEventListener('click', () => {
  state.targets.push({ ticker: '', weight: 0 });
  saveState();
  renderTargets();
});

document.getElementById('addHoldingRow').addEventListener('click', () => {
  state.holdings.push({ ticker: '', value: 0 });
  saveState();
  renderTargets();
});

document.getElementById('generatePlanBtn').addEventListener('click', () => {
  currentPlan = generatePlan();
  planStep = 'recommend';
  switchTab('plan');
});

document.getElementById('reviewAllocationBtn').addEventListener('click', () => {
  planStep = 'projected';
  document.getElementById('view-plan-recommend').hidden = true;
  document.getElementById('view-plan-projected').hidden = false;
  renderProjected();
});

document.getElementById('savePlanBtn').addEventListener('click', () => {
  const plan = currentPlan || generatePlan();
  if (plan.totalBought <= 0) {
    alert('No purchases in this plan yet — nothing to save.');
    return;
  }
  const hMap = holdingsMap();
  plan.rows.forEach(r => {
    if (r.buy > 0) {
      const ticker = r.ticker.toUpperCase();
      const existing = state.holdings.find(h => h.ticker.toUpperCase() === ticker);
      if (existing) existing.value += r.buy;
      else state.holdings.push({ ticker: r.ticker, value: r.buy });
    }
  });
  state.cash = plan.leftover;
  state.activity.push({
    date: new Date().toISOString(),
    totalInvested: plan.totalBought,
    buys: plan.rows.filter(r => r.buy > 0).map(r => ({ ticker: r.ticker, amount: r.buy })),
  });
  saveState();
  currentPlan = null;
  switchTab('portfolio');
});

// ---------- Settings actions ----------

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
      state = imported;
      currentPlan = null;
      saveState();
      renderAll();
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
