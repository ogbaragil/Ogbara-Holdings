// Investment Rebalancing Assistant
// All data lives in localStorage. Nothing is sent anywhere.
//
// Workflow: set a target allocation, enter current holdings, enter cash
// available to invest, and get a buy-only recommendation for where the new
// cash should go (greedy waterfall: fully fund the most underweight ticker
// first, then the next, etc. A ticker is skipped - not partially funded -
// if there isn't enough remaining cash to fully close its gap. Existing
// holdings are never sold.)

const STORAGE_KEY = 'rebalance-assistant-data-v2';

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
  lastUpdated: new Date().toISOString(),
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load saved data, using defaults', e);
  }
  return structuredClone(DEFAULT_DATA);
}

function saveState() {
  state.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderLastUpdated();
}

function fmtMoney(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtMoneyPrecise(n) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtPct(n) {
  return (n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
}

function renderLastUpdated() {
  const d = new Date(state.lastUpdated);
  document.getElementById('lastUpdated').textContent =
    'Last updated ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- Target Allocation table ----------

function renderTargets() {
  const tbody = document.querySelector('#targetTable tbody');
  tbody.innerHTML = '';
  state.targets.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${row.ticker}" data-idx="${idx}" class="target-ticker"></td>
      <td><input type="number" step="0.01" value="${(row.weight * 100).toFixed(2)}" data-idx="${idx}" class="target-weight"></td>
      <td><button class="row-delete" data-idx="${idx}" data-table="target">&times;</button></td>
    `;
    tbody.appendChild(tr);
  });

  const total = state.targets.reduce((s, r) => s + r.weight, 0);
  document.getElementById('targetTotal').textContent = fmtPct(total);
  const warning = document.getElementById('targetWarning');
  warning.textContent = Math.abs(total - 1) > 0.001
    ? `Target weights sum to ${fmtPct(total)}, not 100%. Adjust before relying on the plan below.`
    : '';
}

// ---------- Current Holdings table ----------

function renderHoldings() {
  const tbody = document.querySelector('#holdingsTable tbody');
  tbody.innerHTML = '';
  const holdingsTotal = state.holdings.reduce((s, r) => s + r.value, 0);
  const portfolioTotal = holdingsTotal + (state.cash || 0);

  state.holdings.forEach((row, idx) => {
    const weight = portfolioTotal > 0 ? row.value / portfolioTotal : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${row.ticker}" data-idx="${idx}" class="holding-ticker"></td>
      <td><input type="number" step="0.01" value="${row.value}" data-idx="${idx}" class="holding-value"></td>
      <td>${fmtPct(weight)}</td>
      <td><button class="row-delete" data-idx="${idx}" data-table="holding">&times;</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('holdingsTotal').textContent = fmtMoney(holdingsTotal);
}

function renderCash() {
  document.getElementById('cashInput').value = state.cash;
}

// ---------- Recommended purchases (greedy waterfall) ----------

function computePlan() {
  const holdingsTotal = state.holdings.reduce((s, r) => s + r.value, 0);
  const cash = state.cash || 0;
  const newTotal = holdingsTotal + cash;
  const holdingsByTicker = new Map(state.holdings.map(h => [h.ticker.toUpperCase(), h.value]));

  const rows = state.targets.map(t => {
    const ticker = t.ticker.toUpperCase();
    const currentValue = holdingsByTicker.get(ticker) || 0;
    // current weight relative to the portfolio as it stands today (before investing cash)
    const currentWeightToday = holdingsTotal > 0 ? currentValue / holdingsTotal : 0;
    const targetValue = t.weight * newTotal;
    const gap = targetValue - currentValue;
    return { ticker: t.ticker, currentValue, currentWeightToday, targetWeight: t.weight, gap };
  });

  // Rank by gap descending (most underweight first). Only positive gaps are candidates to buy.
  const ranked = [...rows].sort((a, b) => b.gap - a.gap);

  let remaining = cash;
  const buys = new Map();
  ranked.forEach(r => {
    if (r.gap <= 0) {
      buys.set(r.ticker, 0);
      return;
    }
    if (remaining >= r.gap - 1e-9) {
      buys.set(r.ticker, r.gap);
      remaining -= r.gap;
    } else {
      buys.set(r.ticker, 0); // can't fully close the gap this round - skip, don't partial-fund
    }
  });

  const planRows = rows.map(r => {
    const buy = buys.get(r.ticker) || 0;
    const projectedValue = r.currentValue + buy;
    const projectedWeight = newTotal > 0 ? projectedValue / newTotal : 0;
    const skippedForCash = r.gap > 0 && buy === 0;
    return { ...r, buy, projectedWeight, skippedForCash };
  });

  // Sort display by gap descending too, so priority order is visible
  planRows.sort((a, b) => b.gap - a.gap);

  return { rows: planRows, leftover: Math.max(remaining, 0), newTotal, cash };
}

function renderResults() {
  const plan = computePlan();
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';

  plan.rows.forEach(r => {
    const tr = document.createElement('tr');
    let buyCell;
    if (r.gap <= 0) {
      buyCell = '<span class="skipped">No purchase needed</span>';
    } else if (r.skippedForCash) {
      buyCell = '<span class="skipped">Not this round (not enough cash left)</span>';
    } else {
      buyCell = `<span class="positive">${fmtMoneyPrecise(r.buy)}</span>`;
    }
    tr.innerHTML = `
      <td>${r.ticker}</td>
      <td>${fmtMoney(r.currentValue)}</td>
      <td>${fmtPct(r.currentWeightToday)}</td>
      <td>${fmtPct(r.targetWeight)}</td>
      <td>${buyCell}</td>
      <td>${fmtPct(r.projectedWeight)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('planSummary').textContent =
    `Investing ${fmtMoney(plan.cash)} across your most underweight positions.`;

  const leftoverEl = document.getElementById('leftoverCash');
  leftoverEl.textContent = plan.leftover > 0.01
    ? `${fmtMoneyPrecise(plan.leftover)} left unallocated this round (not enough to fully fund the next underweight position).`
    : '';
}

function renderAll() {
  renderTargets();
  renderHoldings();
  renderCash();
  renderResults();
  renderLastUpdated();
}

// ---------- Event wiring ----------

document.addEventListener('input', (e) => {
  const idx = e.target.dataset.idx;

  if (e.target.id === 'cashInput') {
    state.cash = parseFloat(e.target.value) || 0;
    saveState();
    renderResults();
    return;
  }

  if (idx === undefined) return;

  if (e.target.classList.contains('target-ticker')) {
    state.targets[idx].ticker = e.target.value.toUpperCase();
    saveState();
    renderResults();
  } else if (e.target.classList.contains('target-weight')) {
    state.targets[idx].weight = (parseFloat(e.target.value) || 0) / 100;
    saveState();
    const total = state.targets.reduce((s, r) => s + r.weight, 0);
    document.getElementById('targetTotal').textContent = fmtPct(total);
    const warning = document.getElementById('targetWarning');
    warning.textContent = Math.abs(total - 1) > 0.001
      ? `Target weights sum to ${fmtPct(total)}, not 100%. Adjust before relying on the plan below.`
      : '';
    renderResults();
  } else if (e.target.classList.contains('holding-ticker')) {
    state.holdings[idx].ticker = e.target.value.toUpperCase();
    saveState();
    renderResults();
  } else if (e.target.classList.contains('holding-value')) {
    state.holdings[idx].value = parseFloat(e.target.value) || 0;
    saveState();
    renderHoldings();
    renderResults();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('row-delete')) {
    const idx = parseInt(e.target.dataset.idx, 10);
    const table = e.target.dataset.table;
    if (table === 'target') state.targets.splice(idx, 1);
    else state.holdings.splice(idx, 1);
    saveState();
    renderAll();
  }
});

document.getElementById('addTargetRow').addEventListener('click', () => {
  state.targets.push({ ticker: '', weight: 0 });
  saveState();
  renderAll();
});

document.getElementById('addHoldingRow').addEventListener('click', () => {
  state.holdings.push({ ticker: '', value: 0 });
  saveState();
  renderAll();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rebalancing-data-${new Date().toISOString().slice(0, 10)}.json`;
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
      state = imported;
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
  saveState();
  renderAll();
});

// ---------- Init ----------

renderAll();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.error('SW registration failed', err));
  });
}
