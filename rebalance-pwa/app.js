// Investment Rebalancing Assistant
// All data lives in localStorage. Nothing is sent anywhere.

const STORAGE_KEY = 'rebalance-assistant-data-v1';

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
    { ticker: 'CASH', value: 3018 },
  ],
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
  const total = state.holdings.reduce((s, r) => s + r.value, 0);

  state.holdings.forEach((row, idx) => {
    const weight = total > 0 ? row.value / total : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${row.ticker}" data-idx="${idx}" class="holding-ticker"></td>
      <td><input type="number" step="0.01" value="${row.value}" data-idx="${idx}" class="holding-value"></td>
      <td>${fmtPct(weight)}</td>
      <td><button class="row-delete" data-idx="${idx}" data-table="holding">&times;</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('holdingsTotal').textContent = fmtMoney(total);
}

// ---------- Rebalancing results ----------

function renderResults() {
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';

  const total = state.holdings.reduce((s, r) => s + r.value, 0);
  const holdingsByTicker = new Map(state.holdings.map(h => [h.ticker.toUpperCase(), h.value]));
  const targetTickers = new Set(state.targets.map(t => t.ticker.toUpperCase()));

  // Rows for each target ticker
  state.targets.forEach(t => {
    const ticker = t.ticker.toUpperCase();
    const currentValue = holdingsByTicker.get(ticker) || 0;
    const currentWeight = total > 0 ? currentValue / total : 0;
    const targetValue = t.weight * total;
    const diff = targetValue - currentValue;
    tbody.appendChild(resultRow(t.ticker, currentValue, currentWeight, t.weight, targetValue, diff, false));
  });

  // Rows for holdings not in the target list (e.g. CASH) - fully reallocated
  state.holdings.forEach(h => {
    const ticker = h.ticker.toUpperCase();
    if (targetTickers.has(ticker)) return;
    const currentWeight = total > 0 ? h.value / total : 0;
    tbody.appendChild(resultRow(h.ticker, h.value, currentWeight, 0, 0, -h.value, true));
  });
}

function resultRow(ticker, currentValue, currentWeight, targetWeight, targetValue, diff, notInTarget) {
  const tr = document.createElement('tr');
  const diffClass = diff > 0.5 ? 'positive' : diff < -0.5 ? 'negative' : '';
  const diffLabel = diff >= 0 ? `Buy ${fmtMoney(diff)}` : `Sell ${fmtMoney(Math.abs(diff))}`;
  tr.innerHTML = `
    <td>${ticker}${notInTarget ? ' <span class="not-in-target">(not in target)</span>' : ''}</td>
    <td>${fmtMoney(currentValue)}</td>
    <td>${fmtPct(currentWeight)}</td>
    <td>${notInTarget ? '—' : fmtPct(targetWeight)}</td>
    <td>${notInTarget ? '—' : fmtMoney(targetValue)}</td>
    <td class="${diffClass}">${diffLabel}</td>
  `;
  return tr;
}

function renderAll() {
  renderTargets();
  renderHoldings();
  renderResults();
  renderLastUpdated();
}

// ---------- Event wiring ----------

document.addEventListener('input', (e) => {
  const idx = e.target.dataset.idx;
  if (idx === undefined) return;

  if (e.target.classList.contains('target-ticker')) {
    state.targets[idx].ticker = e.target.value.toUpperCase();
    saveState();
    renderResults();
  } else if (e.target.classList.contains('target-weight')) {
    state.targets[idx].weight = (parseFloat(e.target.value) || 0) / 100;
    saveState();
    document.getElementById('targetTotal').textContent = fmtPct(state.targets.reduce((s, r) => s + r.weight, 0));
    const total = state.targets.reduce((s, r) => s + r.weight, 0);
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
