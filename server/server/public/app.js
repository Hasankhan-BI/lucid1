/* ===================== STATE ===================== */
const state = {
  token: localStorage.getItem('lucid_token') || null,
  datasetId: null, datasetName: null,
  rows: [], columns: [], rowCount: 0,
  numericCols: [], categoricalCols: [], dateCols: [],
  insights: [], correlations: [], forecast: null,
  charts: {}, messages: []
};

/* ===================== API HELPERS ===================== */
async function apiFetch(path, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, state.token ? { Authorization: 'Bearer ' + state.token } : {});
  const res = await fetch(path, opts);
  if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
  return res;
}
async function apiJSON(path, method, body) {
  const res = await apiFetch(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ===================== AUTH ===================== */
let authMode = 'login';
const authOverlay = document.getElementById('authOverlay');

function showAuth(mode) {
  authMode = mode;
  document.getElementById('authTitle').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
  document.getElementById('authSub').textContent = mode === 'login'
    ? 'Sign in to upload data and pick up where you left off.'
    : 'Takes a few seconds — no credit card, just an email and password.';
  document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  document.getElementById('authSwitchText').textContent = mode === 'login' ? 'New here?' : 'Already have an account?';
  document.getElementById('authSwitchBtn').textContent = mode === 'login' ? 'Create an account' : 'Sign in instead';
  document.getElementById('authError').textContent = '';
  authOverlay.style.display = 'flex';
}
document.getElementById('authSwitchBtn').addEventListener('click', () => showAuth(authMode === 'login' ? 'register' : 'login'));
document.getElementById('authSubmitBtn').addEventListener('click', submitAuth);
document.getElementById('authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });

async function submitAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please fill in both fields.'; return; }
  try {
    const data = await apiJSON('/api/auth/' + authMode, 'POST', { email, password });
    state.token = data.token;
    localStorage.setItem('lucid_token', data.token);
    authOverlay.style.display = 'none';
    await afterLogin();
  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong.';
  }
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);
function doLogout() {
  state.token = null;
  localStorage.removeItem('lucid_token');
  authOverlay.style.display = 'flex';
  resetDashboardState();
  showAuth('login');
}
function resetDashboardState() {
  document.getElementById('uploadSummary').style.display = 'none';
  document.getElementById('dashEmpty').style.display = 'block';
  document.getElementById('dashContent').style.display = 'none';
  document.getElementById('insightsEmpty').style.display = 'block';
  document.getElementById('insightsContent').style.display = 'none';
  document.getElementById('forecastEmpty').style.display = 'block';
  document.getElementById('forecastContent').style.display = 'none';
  document.getElementById('chatEmpty').style.display = 'block';
  document.getElementById('chatContent').style.display = 'none';
  document.getElementById('statusDot').classList.remove('on');
  document.getElementById('statusText').textContent = 'No dataset loaded';
  document.getElementById('pillText').textContent = 'No file yet';
  document.getElementById('datasetPicker').style.display = 'none';
}

async function afterLogin() {
  await refreshDatasetPicker();
}

/* boot */
(async function boot() {
  if (!state.token) { showAuth('login'); return; }
  try {
    await apiJSON('/api/auth/me', 'GET');
    authOverlay.style.display = 'none';
    await afterLogin();
  } catch (err) {
    showAuth('login');
  }
})();

/* ===================== DATASET PICKER ===================== */
async function refreshDatasetPicker() {
  const picker = document.getElementById('datasetPicker');
  try {
    const list = await apiJSON('/api/datasets', 'GET');
    if (!list.length) { picker.style.display = 'none'; return; }
    picker.innerHTML = list.map(d => `<option value="${d.id}">${escapeHtml(d.name)} · ${d.rowCount} rows</option>`).join('');
    picker.style.display = 'inline-block';
    picker.onchange = () => loadDataset(picker.value);
    if (!state.datasetId) await loadDataset(list[0].id);
  } catch (err) { /* not fatal */ }
}

async function loadDataset(id) {
  const data = await apiJSON('/api/datasets/' + id, 'GET');
  applyDatasetPayload(data);
  document.getElementById('datasetPicker').value = id;
}

function applyDatasetPayload(data) {
  state.datasetId = data.id;
  state.datasetName = data.name;
  state.rowCount = data.rowCount;
  state.columns = data.columns;
  state.numericCols = data.numericCols;
  state.categoricalCols = data.categoricalCols;
  state.dateCols = data.dateCols;
  state.correlations = data.correlations;
  state.insights = data.insights;
  state.forecast = data.forecast || null;
  state.joinInfo = data.joinInfo || null;
  state.rows = (data.rows || []).map(r => {
    const copy = { ...r };
    state.dateCols.forEach(dc => { if (copy[dc]) copy[dc] = new Date(copy[dc]); });
    return copy;
  });

  renderSchema();
  renderDashboard();
  renderInsights();
  setupForecastControls();
  setupChat();

  document.getElementById('statusDot').classList.add('on');
  document.getElementById('statusText').textContent = data.name;
  const joinBadge = state.joinInfo ? ` <span style="color:var(--teal);font-weight:600;">· combined</span>` : '';
  document.getElementById('pillText').innerHTML = '<b>' + escapeHtml(data.name) + '</b> · ' + data.rowCount + ' rows' + joinBadge;
  document.getElementById('uploadSummary').style.display = 'block';
  goPanel('dashboard');
}

/* ===================== NAV ===================== */
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goPanel(btn.dataset.panel));
});
function goPanel(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  const titles = {
    upload: ['Upload your data', 'CSV or TSV — Lucid profiles it, builds a dashboard, and grounds the agent in the real numbers.'],
    combine: ['Combine two datasets', 'Join related files on a shared column, like Power BI relationships.'],
    clean: ['Clean a dataset', 'Fix missing values, inconsistent text, outliers, and duplicates.'],
    dashboard: ['Dashboard', "Auto-generated from your dataset's actual structure."],
    insights: ['Insights', 'Plain-language findings, each traceable to a real calculation.'],
    forecast: ['Forecast', 'A transparent, linear projection — not a black box.'],
    chat: ['Ask the Agent', 'Grounded in your uploaded data, nothing else.']
  };
  document.getElementById('topTitle').textContent = titles[name][0];
  document.getElementById('topSub').textContent = titles[name][1];
  if (name === 'combine') setupCombinePanel();
  if (name === 'clean') setupCleanPanel();
}

/* ===================== FILE UPLOAD ===================== */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', e => { if (e.target.id !== 'sampleBtn' && e.target.id !== 'browseBtn') fileInput.click(); });
fileInput.addEventListener('change', e => { if (e.target.files.length) handleFiles([...e.target.files]); });
['dragover', 'dragenter'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]); });

document.getElementById('sampleBtn').addEventListener('click', () => {
  const csv = generateSampleCSV();
  const blob = new Blob([csv], { type: 'text/csv' });
  const file = new File([blob], 'sample_sales_data.csv', { type: 'text/csv' });
  handleFiles([file]);
});

// Uploads one or more files in sequence (not parallel — keeps server load
// predictable and lets the progress list update file by file rather than
// all finishing at once with no feedback in between). The dashboard opens
// on the last successfully uploaded file when it's done.
async function handleFiles(files) {
  if (!state.token) { showAuth('login'); return; }
  const dz = document.getElementById('dropzone');
  const originalHtml = dz.innerHTML;

  const statuses = files.map(f => ({ name: f.name, state: 'pending' }));
  const renderProgress = () => {
    dz.innerHTML = `
      <h3>Uploading ${files.length > 1 ? files.length + ' files' : '1 file'}…</h3>
      <div class="upload-progress-list">
        ${statuses.map(s => `
          <div class="upload-progress-row upload-progress-${s.state}">
            <span class="upload-progress-icon">${s.state === 'done' ? '✓' : s.state === 'error' ? '✕' : s.state === 'active' ? '…' : '·'}</span>
            <span class="upload-progress-name">${escapeHtml(s.name)}</span>
            ${s.error ? `<span class="upload-progress-error">${escapeHtml(s.error)}</span>` : ''}
          </div>`).join('')}
      </div>`;
  };
  renderProgress();

  let lastSuccessful = null;
  for (let i = 0; i < files.length; i++) {
    statuses[i].state = 'active';
    renderProgress();
    const form = new FormData();
    form.append('file', files[i]);
    try {
      const res = await apiFetch('/api/datasets/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      statuses[i].state = 'done';
      lastSuccessful = data;
    } catch (err) {
      statuses[i].state = 'error';
      statuses[i].error = err.message || 'Could not upload this file.';
    }
    renderProgress();
  }

  await refreshDatasetPicker();
  if (lastSuccessful) applyDatasetPayload(lastSuccessful);

  // Leave the progress list visible for a moment so errors are readable,
  // rather than snapping straight to the dashboard and hiding them.
  const anyErrors = statuses.some(s => s.state === 'error');
  if (!anyErrors) {
    setTimeout(() => { dz.innerHTML = originalHtml; }, 400);
  }
}


function generateSampleCSV() {
  const regions = ['North', 'South', 'East', 'West'];
  const cats = ['Hardware', 'Software', 'Services'];
  let rows = [['date', 'region', 'category', 'revenue', 'units', 'cost']];
  let base = 18000;
  for (let m = 0; m < 24; m++) {
    const d = new Date(2024, 0, 1); d.setMonth(d.getMonth() + m);
    const dateStr = d.toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) {
      const region = regions[(m + i) % regions.length];
      const cat = cats[(m + i) % cats.length];
      const seasonal = 1 + 0.15 * Math.sin(m / 12 * 2 * Math.PI);
      const noise = 0.85 + Math.random() * 0.3;
      const revenue = Math.round(base * seasonal * noise * (1 + m * 0.012));
      const units = Math.round(revenue / (40 + Math.random() * 20));
      const cost = Math.round(revenue * (0.55 + Math.random() * 0.12));
      rows.push([dateStr, region, cat, revenue, units, cost]);
    }
  }
  return rows.map(r => r.join(',')).join('\n');
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return (Math.round(n * 100) / 100).toString();
}

/* ===================== SCHEMA TABLE ===================== */
function renderSchema() {
  document.getElementById('metaRows').textContent = state.rowCount.toLocaleString();
  document.getElementById('metaCols').textContent = state.columns.length;
  const totalMissing = state.columns.reduce((a, c) => a + c.missing, 0);
  const totalCells = state.columns.length * state.rowCount;
  document.getElementById('metaMissing').textContent = (totalCells ? (totalMissing / totalCells * 100).toFixed(1) : 0) + '%';

  const body = document.getElementById('schemaBody');
  body.innerHTML = state.columns.map(c => {
    let summary = '—';
    if (c.type === 'numeric') summary = `min ${fmt(c.stats.min)} · mean ${fmt(c.stats.mean)} · max ${fmt(c.stats.max)}`;
    else if (c.type === 'date') summary = `${c.stats.min} → ${c.stats.max}`;
    else if (c.type === 'categorical') summary = `${c.stats.distinct} distinct · top: ${escapeHtml(c.stats.top[0] ? String(c.stats.top[0][0]) : '—')}`;
    return `<tr><td>${escapeHtml(c.name)}</td><td><span class="type-badge type-${c.type === 'empty' ? 'categorical' : c.type}">${c.type}</span></td><td>${summary}${c.missingPct > 0 ? ` · ${c.missingPct}% missing` : ''}</td></tr>`;
  }).join('');
}

/* ===================== DASHBOARD ===================== */
// Columns like "Organization Id" or "Name" are technically categorical (not
// numeric, not dates) but are effectively unique per row — charting them as
// "count by category" or "share" produces bars that are all 1 and pie slices
// that look meaningful but represent single rows. This filters those out so
// charts only use columns where values genuinely repeat.
function meaningfulCategoricalCols() {
  return state.categoricalCols.filter(name => {
    const stats = state.columns.find(c => c.name === name).stats;
    return state.rowCount > 0 && (stats.distinct / state.rowCount) <= 0.5;
  });
}

function renderDashboard() {
  document.getElementById('dashEmpty').style.display = 'none';
  document.getElementById('dashContent').style.display = 'block';

  const kpiGrid = document.getElementById('kpiGrid');
  const totalMissing = state.columns.reduce((a, c) => a + c.missing, 0);
  const totalCells = state.columns.length * state.rowCount;
  const kpis = [
    { label: 'Total rows', value: state.rowCount.toLocaleString(), delta: `${state.columns.length} columns detected` },
    { label: 'Data completeness', value: (100 - (totalCells ? totalMissing / totalCells * 100 : 0)).toFixed(1) + '%', delta: 'across all fields' },
  ];
  state.numericCols.slice(0, 2).forEach(col => {
    const s = state.columns.find(c => c.name === col).stats;
    kpis.push({ label: escapeHtml(col) + ' (avg)', value: fmt(s.mean), delta: `range ${fmt(s.min)} – ${fmt(s.max)}` });
  });
  kpiGrid.innerHTML = kpis.map(k => `
    <div class="kpi-card">
      <div class="label">${k.label}</div>
      <div class="value mono">${k.value}</div>
      <div class="delta">${k.delta}</div>
    </div>`).join('');

  const chartGrid = document.getElementById('chartGrid');
  chartGrid.innerHTML = '';
  Object.values(state.charts).forEach(c => c && c.destroy && c.destroy());
  state.charts = {};

  if (state.dateCols.length && state.numericCols.length) {
    const wrap = document.createElement('div');
    wrap.className = 'chart-card full';
    wrap.innerHTML = `<h4>${escapeHtml(state.numericCols[0])} over time</h4><div class="cap">Grouped by ${escapeHtml(state.dateCols[0])}</div><canvas id="chartTrend"></canvas>`;
    chartGrid.appendChild(wrap);
    const grouped = groupByDate(state.dateCols[0], state.numericCols[0]);
    state.charts.trend = new Chart(document.getElementById('chartTrend'), {
      type: 'line',
      data: { labels: grouped.labels, datasets: [{ label: state.numericCols[0], data: grouped.values, borderColor: '#0F9B8E', backgroundColor: 'rgba(15,155,142,0.08)', fill: true, tension: .3, pointRadius: 2 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { grid: { color: '#EEF0F3' } }, x: { grid: { display: false } } } }
    });
  }

  const chartableCats = meaningfulCategoricalCols();
  if (chartableCats.length) {
    const col = chartableCats[0];
    const stats = state.columns.find(c => c.name === col).stats;
    const wrap = document.createElement('div');
    wrap.className = 'chart-card';
    wrap.innerHTML = `<h4>${escapeHtml(col)} breakdown</h4><div class="cap">Count by category</div><canvas id="chartCat"></canvas>`;
    chartGrid.appendChild(wrap);
    state.charts.cat = new Chart(document.getElementById('chartCat'), {
      type: 'bar',
      data: { labels: stats.top.map(t => t[0]), datasets: [{ data: stats.top.map(t => t[1]), backgroundColor: '#6D5AE6', borderRadius: 5 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { grid: { color: '#EEF0F3' } }, x: { grid: { display: false } } } }
    });
  }

  if (state.numericCols.length) {
    const col = state.numericCols[0];
    const stats = state.columns.find(c => c.name === col).stats;
    const nums = state.rows.map(r => r[col]).filter(v => typeof v === 'number');
    const bins = 8;
    const width = (stats.max - stats.min) / bins || 1;
    const counts = new Array(bins).fill(0);
    nums.forEach(v => { let idx = Math.floor((v - stats.min) / width); if (idx >= bins) idx = bins - 1; if (idx < 0) idx = 0; counts[idx]++; });
    const labels = counts.map((_, i) => fmt(stats.min + i * width));
    const wrap = document.createElement('div');
    wrap.className = 'chart-card';
    wrap.innerHTML = `<h4>${escapeHtml(col)} distribution</h4><div class="cap">Frequency across value range</div><canvas id="chartHist"></canvas>`;
    chartGrid.appendChild(wrap);
    state.charts.hist = new Chart(document.getElementById('chartHist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: counts, backgroundColor: '#C9820A', borderRadius: 5 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { grid: { color: '#EEF0F3' } }, x: { grid: { display: false } } } }
    });
  }

  if (chartableCats.length > 1) {
    const col = chartableCats[1];
    const stats = state.columns.find(c => c.name === col).stats;
    const wrap = document.createElement('div');
    wrap.className = 'chart-card';
    wrap.innerHTML = `<h4>${escapeHtml(col)} share</h4><div class="cap">Proportion of rows</div><canvas id="chartPie"></canvas>`;
    chartGrid.appendChild(wrap);
    state.charts.pie = new Chart(document.getElementById('chartPie'), {
      type: 'doughnut',
      data: { labels: stats.top.map(t => t[0]), datasets: [{ data: stats.top.map(t => t[1]), backgroundColor: ['#0F9B8E', '#6D5AE6', '#C9820A', '#5B6472', '#C93838', '#8891A0'] }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10.5 } } } } }
    });
  }
}

function groupByDate(dateCol, numCol) {
  const map = {};
  state.rows.forEach(r => {
    let d = r[dateCol]; if (!(d instanceof Date)) d = new Date(d);
    if (isNaN(d)) return;
    const key = d.toISOString().slice(0, 7);
    const v = r[numCol];
    if (typeof v !== 'number') return;
    if (!map[key]) map[key] = { sum: 0, count: 0 };
    map[key].sum += v; map[key].count++;
  });
  const labels = Object.keys(map).sort();
  return { labels, values: labels.map(k => +(map[k].sum).toFixed(2)) };
}

/* ===================== INSIGHTS (server-computed) ===================== */
function renderInsights() {
  document.getElementById('insightsEmpty').style.display = 'none';
  document.getElementById('insightsContent').style.display = 'block';
  document.getElementById('insightsList').innerHTML = state.insights.map(i => `
    <div class="insight-card">
      <div class="insight-icon ${i.icon}">${iconFor(i.icon)}</div>
      <div class="insight-body">
        <p>${escapeHtml(i.text)}</p>
        <div class="stamp">${escapeHtml(i.stamp)}</div>
      </div>
    </div>`).join('');
}
function iconFor(kind) {
  return { trend: '📈', outlier: '⚠️', corr: '🔗', summary: '▦' }[kind] || '•';
}

/* ===================== FORECAST (server-computed) ===================== */
function setupForecastControls() {
  const empty = document.getElementById('forecastEmpty');
  const content = document.getElementById('forecastContent');
  if (!state.dateCols.length || !state.numericCols.length) {
    empty.style.display = 'block'; content.style.display = 'none'; return;
  }
  empty.style.display = 'none'; content.style.display = 'block';
  const sel = document.getElementById('forecastMetric');
  sel.innerHTML = state.numericCols.map((c, idx) => `<option value="${idx}">${escapeHtml(c)}</option>`).join('');
  document.getElementById('runForecastBtn').onclick = runForecast;
  runForecast();
}

async function runForecast() {
  const metricIdx = +document.getElementById('forecastMetric').value;
  const metric = state.numericCols[metricIdx];
  const horizon = +document.getElementById('forecastHorizon').value;
  const caveat = document.getElementById('forecastCaveat');
  caveat.textContent = 'Running forecast…';
  try {
    const result = await apiJSON(`/api/datasets/${state.datasetId}/forecast`, 'POST', { metric, horizon });
    state.forecast = result;

    const allLabels = [...result.historicalLabels, ...result.futureLabels];
    const actualData = [...result.historicalValues, ...new Array(horizon).fill(null)];
    const n = result.historicalValues.length;
    const projData = [...new Array(n - 1).fill(null), result.historicalValues[n - 1], ...result.projected];

    if (state.charts.forecast) state.charts.forecast.destroy();
    state.charts.forecast = new Chart(document.getElementById('forecastChart'), {
      type: 'line',
      data: {
        labels: allLabels, datasets: [
          { label: 'Actual', data: actualData, borderColor: '#0F9B8E', backgroundColor: 'rgba(15,155,142,0.08)', fill: true, tension: .25, pointRadius: 2 },
          { label: 'Projected', data: projData, borderColor: '#C9820A', borderDash: [6, 4], pointRadius: 2, fill: false }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { grid: { color: '#EEF0F3' } }, x: { grid: { display: false } } } }
    });

    caveat.innerHTML = `<b>How to read this:</b> ${escapeHtml(result.summary)}`;
  } catch (err) {
    caveat.textContent = err.message || 'Could not generate a forecast for this metric.';
  }
}

/* ===================== CHAT AGENT (server-proxied) ===================== */
async function setupChat() {
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('chatContent').style.display = 'block';
  document.getElementById('chatLog').innerHTML = '';
  state.messages = [];

  let history = [];
  try { history = await apiJSON(`/api/datasets/${state.datasetId}/chat`, 'GET'); } catch (err) { /* ignore */ }

  if (history.length) {
    history.forEach(m => {
      if (m.role === 'user') addUserMessage(m.content, false);
      else addAgentMessage(m.content, "Grounded in your uploaded dataset's computed stats", false);
    });
  } else {
    addAgentMessage(
      `I've read through ${state.datasetName}: ${state.rowCount} rows across ${state.columns.length} columns (${state.numericCols.join(', ') || 'no numeric columns'}). Ask me about trends, outliers, or what to do next — I'll only answer from what's actually in this data.`,
      'Grounded in dataset schema', false
    );
  }

  const suggestions = [
    state.dateCols.length && state.numericCols.length ? `What's the trend in ${state.numericCols[0]}?` : null,
    state.correlations.length ? `What's driving changes in ${state.numericCols[0] || 'this data'}?` : null,
    'What should I pay attention to first?',
    state.forecast || (state.dateCols.length && state.numericCols.length) ? 'What does the forecast suggest I should do?' : null
  ].filter(Boolean);
  document.getElementById('chatSuggestions').innerHTML = suggestions.map(s => `<button class="chip" onclick="askSuggestion(this)">${escapeHtml(s)}</button>`).join('');

  document.getElementById('chatSendBtn').onclick = sendChat;
  const input = document.getElementById('chatInput');
  input.replaceWith(input.cloneNode(true)); // clear old listeners on dataset switch
  document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
}
function askSuggestion(btn) {
  document.getElementById('chatInput').value = btn.textContent;
  sendChat();
}

function addUserMessage(text, remember = true) {
  if (remember) state.messages.push({ role: 'user', text });
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function addAgentMessage(text, stampText, remember = true) {
  if (remember) state.messages.push({ role: 'assistant', text });
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.innerHTML = escapeHtml(text) + (stampText ? `<div class="stamp">${stampText}</div>` : '');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function addTyping() {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'msg agent'; div.id = 'typingMsg';
  div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  log.appendChild(div); log.scrollTop = log.scrollHeight;
}
function removeTyping() { const t = document.getElementById('typingMsg'); if (t) t.remove(); }
function escapeHtml(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/\n/g, '<br>');
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addUserMessage(text);
  addTyping();
  try {
    const data = await apiJSON(`/api/datasets/${state.datasetId}/chat`, 'POST', { message: text });
    removeTyping();
    addAgentMessage(data.content, "Grounded in your uploaded dataset's computed stats");
  } catch (err) {
    removeTyping();
    addAgentMessage(err.message || 'Something went wrong reaching the analysis engine. Please try again.', null, false);
  }
}

/* ===================== COMBINE DATASETS ===================== */
async function setupCombinePanel() {
  let list = [];
  try { list = await apiJSON('/api/datasets', 'GET'); } catch (err) { /* not fatal */ }

  const empty = document.getElementById('combineEmpty');
  const content = document.getElementById('combineContent');
  if (list.length < 2) {
    empty.style.display = 'block'; content.style.display = 'none'; return;
  }
  empty.style.display = 'none'; content.style.display = 'block';

  const selA = document.getElementById('combineDatasetA');
  const selB = document.getElementById('combineDatasetB');
  const optionsHtml = list.map(d => `<option value="${d.id}">${escapeHtml(d.name)} · ${d.rowCount} rows</option>`).join('');
  selA.innerHTML = optionsHtml;
  selB.innerHTML = optionsHtml;
  // Default to two different datasets when possible, so the columns
  // populate meaningfully on first open instead of both pointing at #1.
  if (list.length > 1) selB.value = list[1].id;

  selA.onchange = () => populateJoinColumnOptions('A');
  selB.onchange = () => populateJoinColumnOptions('B');
  await populateJoinColumnOptions('A');
  await populateJoinColumnOptions('B');

  document.getElementById('combineRunBtn').onclick = runCombine;
  document.getElementById('combineResult').innerHTML = '';
}

async function populateJoinColumnOptions(which) {
  const datasetSel = document.getElementById('combineDataset' + which);
  const columnSel = document.getElementById('combineColumn' + which);
  const datasetId = datasetSel.value;
  if (!datasetId) { columnSel.innerHTML = ''; return; }
  try {
    const data = await apiJSON('/api/datasets/' + datasetId, 'GET');
    columnSel.innerHTML = data.columns.map(c => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)} (${c.type})</option>`).join('');

    // If the other side already has a column selected with the exact same
    // name (e.g. both files have "customer_id"), default to it here too —
    // leaving mismatched defaults in place is exactly how a join silently
    // ends up matching the wrong columns.
    const otherWhich = which === 'A' ? 'B' : 'A';
    const otherColumnSel = document.getElementById('combineColumn' + otherWhich);
    const otherValue = otherColumnSel ? otherColumnSel.value : '';
    if (otherValue && data.columns.some(c => c.name === otherValue)) {
      columnSel.value = otherValue;
    }
  } catch (err) {
    columnSel.innerHTML = '';
  }
}
// Attribute-safe escaping (option value=""), distinct from escapeHtml which
// is only safe for text content — an unescaped quote in a column name could
// otherwise break out of the attribute here.
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function runCombine() {
  const datasetAId = document.getElementById('combineDatasetA').value;
  const columnA = document.getElementById('combineColumnA').value;
  const datasetBId = document.getElementById('combineDatasetB').value;
  const columnB = document.getElementById('combineColumnB').value;
  const resultEl = document.getElementById('combineResult');

  if (!datasetAId || !datasetBId || !columnA || !columnB) {
    resultEl.innerHTML = `<div class="join-banner warn">Pick both datasets and both join columns first.</div>`;
    return;
  }
  if (datasetAId === datasetBId) {
    resultEl.innerHTML = `<div class="join-banner warn">Pick two different datasets to combine.</div>`;
    return;
  }

  resultEl.innerHTML = `<div class="join-banner warn">Combining…</div>`;
  try {
    const data = await apiJSON('/api/datasets/combine', 'POST', { datasetAId, columnA, datasetBId, columnB });
    const j = data.joinInfo;
    const matchRateA = j.rowsA ? Math.round((j.rowsA - j.unmatchedA) / j.rowsA * 100) : 0;
    const dupNote = j.duplicateKeyGroups ? ` ${j.duplicateKeyGroups} key value(s) matched more than one row on the second dataset, so some rows appear more than once in the result — that's expected for one-to-many relationships (e.g. one customer, many orders), but worth knowing.` : '';
    resultEl.innerHTML = `
      <div class="join-banner good">
        <b>Combined into "${escapeHtml(data.name)}"</b> — joined on <code>${escapeHtml(j.columnA)}</code> ↔ <code>${escapeHtml(j.columnB)}</code>: ${data.rowCount} matched rows (${matchRateA}% of ${escapeHtml(j.datasetAName)} matched).
        ${j.unmatchedA} row(s) in ${escapeHtml(j.datasetAName)} had no match, ${j.unmatchedB} row(s) in ${escapeHtml(j.datasetBName)} had no match.${dupNote}
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="loadDataset('${data.id}')">View combined dashboard</button>
    `;
    await refreshDatasetPicker();
  } catch (err) {
    resultEl.innerHTML = `<div class="join-banner warn">${escapeHtml(err.message || 'Could not combine these datasets.')}</div>`;
  }
}

/* ===================== CLEAN DATA ===================== */
let cleanDatasetCache = null; // full dataset detail for whichever dataset is picked

async function setupCleanPanel() {
  let list = [];
  try { list = await apiJSON('/api/datasets', 'GET'); } catch (err) { /* not fatal */ }

  const empty = document.getElementById('cleanEmpty');
  const content = document.getElementById('cleanContent');
  if (!list.length) { empty.style.display = 'block'; content.style.display = 'none'; return; }
  empty.style.display = 'none'; content.style.display = 'block';

  const picker = document.getElementById('cleanDatasetPicker');
  picker.innerHTML = list.map(d => `<option value="${d.id}">${escapeHtml(d.name)} · ${d.rowCount} rows</option>`).join('');
  picker.onchange = () => loadCleanTable(picker.value);
  await loadCleanTable(picker.value);

  document.getElementById('cleanRunBtn').onclick = runClean;
  document.getElementById('cleanResult').innerHTML = '';
}

async function loadCleanTable(datasetId) {
  const body = document.getElementById('cleanTableBody');
  body.innerHTML = `<tr><td colspan="3">Loading…</td></tr>`;
  try {
    cleanDatasetCache = await apiJSON('/api/datasets/' + datasetId, 'GET');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3">Could not load this dataset.</td></tr>`;
    return;
  }

  const rows = cleanDatasetCache.columns.map(c => {
    const issues = [];
    if (c.missingPct > 0) issues.push(`${c.missingPct}% missing`);
    if (c.type === 'numeric' && c.stats.outlierCount > 0) issues.push(`${c.stats.outlierCount} outlier(s)`);
    const issueText = issues.length ? issues.join(', ') : 'None detected';

    let fixControl = '<span style="color:var(--slate-2);font-size:12px;">—</span>';
    if (c.missingPct > 0 || c.type !== 'date') {
      const missingOptions = ['<option value="none">Leave as is</option>'];
      if (c.missingPct > 0) {
        missingOptions.push('<option value="drop_row">Drop rows missing this</option>');
        if (c.type === 'numeric') {
          missingOptions.push('<option value="fill_mean">Fill missing with mean</option>');
          missingOptions.push('<option value="fill_median">Fill missing with median</option>');
        } else {
          missingOptions.push('<option value="fill_mode">Fill missing with most common</option>');
        }
      }
      const textControls = c.type === 'categorical' ? `
        <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;margin-top:6px;">
          <input type="checkbox" class="clean-trim" data-col="${escapeAttr(c.name)}" style="width:13px;height:13px;" /> Trim whitespace
        </label>
        <select class="clean-case" data-col="${escapeAttr(c.name)}" style="margin-top:5px;font-size:11.5px;padding:5px 26px 5px 8px;">
          <option value="">Keep casing</option>
          <option value="upper">UPPERCASE</option>
          <option value="lower">lowercase</option>
          <option value="title">Title Case</option>
        </select>` : '';
      const outlierControl = (c.type === 'numeric' && c.stats.outlierCount > 0) ? `
        <label style="display:flex;align-items:center;gap:5px;font-size:11.5px;margin-top:6px;">
          <input type="checkbox" class="clean-outliers" data-col="${escapeAttr(c.name)}" style="width:13px;height:13px;" /> Remove ${c.stats.outlierCount} outlier row(s)
        </label>` : '';
      fixControl = `
        <select class="clean-missing" data-col="${escapeAttr(c.name)}">${missingOptions.join('')}</select>
        ${textControls}${outlierControl}`;
    }

    return `<tr><td>${escapeHtml(c.name)}</td><td>${issueText}</td><td>${fixControl}</td></tr>`;
  }).join('');

  body.innerHTML = rows;
}

async function runClean() {
  const resultEl = document.getElementById('cleanResult');
  if (!cleanDatasetCache) return;

  const columnOps = {};
  document.querySelectorAll('.clean-missing').forEach(sel => {
    if (sel.value !== 'none') columnOps[sel.dataset.col] = { ...(columnOps[sel.dataset.col] || {}), missingStrategy: sel.value };
  });
  document.querySelectorAll('.clean-trim').forEach(cb => {
    if (cb.checked) columnOps[cb.dataset.col] = { ...(columnOps[cb.dataset.col] || {}), trim: true };
  });
  document.querySelectorAll('.clean-case').forEach(sel => {
    if (sel.value) columnOps[sel.dataset.col] = { ...(columnOps[sel.dataset.col] || {}), case: sel.value };
  });
  const removeOutliers = [...document.querySelectorAll('.clean-outliers')].filter(cb => cb.checked).map(cb => cb.dataset.col);
  const removeDuplicates = document.getElementById('cleanRemoveDuplicates').checked;

  if (!Object.keys(columnOps).length && !removeOutliers.length && !removeDuplicates) {
    resultEl.innerHTML = `<div class="join-banner warn">Pick at least one fix before running — nothing is selected right now.</div>`;
    return;
  }

  resultEl.innerHTML = `<div class="join-banner warn">Cleaning…</div>`;
  try {
    const data = await apiJSON(`/api/datasets/${cleanDatasetCache.id}/clean`, 'POST', { removeDuplicates, columnOps, removeOutliers });
    const r = data.cleaningInfo.report;
    const parts = [];
    if (r.duplicatesRemoved) parts.push(`${r.duplicatesRemoved} duplicate row(s) removed`);
    if (r.outliersRemoved) parts.push(`${r.outliersRemoved} outlier row(s) removed`);
    if (r.rowsDroppedForMissing) parts.push(`${r.rowsDroppedForMissing} row(s) dropped for missing values`);
    const filledCount = Object.values(r.missingFilled).reduce((a, f) => a + f.count, 0);
    if (filledCount) parts.push(`${filledCount} missing value(s) filled`);
    resultEl.innerHTML = `
      <div class="join-banner good">
        <b>Cleaned into "${escapeHtml(data.name)}"</b> — ${r.startingRows} rows → ${r.endingRows} rows. ${parts.join('. ')}.
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="loadDataset('${data.id}')">View cleaned dashboard</button>
    `;
  } catch (err) {
    resultEl.innerHTML = `<div class="join-banner warn">${escapeHtml(err.message || 'Could not clean this dataset.')}</div>`;
  }
}
