// Core analytics engine. Pure functions, no I/O — takes parsed rows in,
// returns a profile object out. Ported from the browser prototype so the
// exact same statistics power both the instant client preview and the
// authoritative server-computed dashboard.

function isDateLike(v) {
  if (v instanceof Date) return true;
  if (typeof v !== 'string') return false;
  if (!/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) return false;
  return !isNaN(Date.parse(v));
}

function numericStats(nums) {
  const n = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sorted = [...nums].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = nums.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const std = Math.sqrt(variance);
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const outliers = nums.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
  return { n, sum, mean, median, std, min: sorted[0], max: sorted[n - 1], q1, q3, outlierCount: outliers.length };
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return num / Math.sqrt(dx * dy);
}

function linreg(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return (Math.round(n * 100) / 100).toString();
}

// Groups rows by year-month using dateCol, summing numCol within each month.
function groupByDate(rows, dateCol, numCol) {
  const map = {};
  rows.forEach(r => {
    let d = r[dateCol]; if (!(d instanceof Date)) d = new Date(d);
    if (isNaN(d)) return;
    const key = d.toISOString().slice(0, 7);
    const v = r[numCol];
    if (typeof v !== 'number') return;
    if (!map[key]) map[key] = { sum: 0, count: 0 };
    map[key].sum += v; map[key].count++;
  });
  const labels = Object.keys(map).sort();
  return { labels, values: labels.map(k => +map[k].sum.toFixed(2)) };
}

// Profiles an array of row objects. Returns everything the dashboard,
// insights panel, and grounded chat agent need.
function profileRows(rows) {
  rows = rows.filter(r => Object.values(r).some(v => v !== null && v !== '' && v !== undefined));
  if (!rows.length) throw new Error('No usable rows found');

  const keys = Object.keys(rows[0]);
  const columns = [];
  const numericCols = [], categoricalCols = [], dateCols = [];

  keys.forEach(key => {
    const vals = rows.map(r => r[key]);
    const nonNull = vals.filter(v => v !== null && v !== undefined && v !== '');
    const missing = vals.length - nonNull.length;
    const numericCount = nonNull.filter(v => typeof v === 'number' && !isNaN(v)).length;
    const dateCount = nonNull.filter(isDateLike).length;

    let type;
    if (nonNull.length === 0) type = 'empty';
    else if (numericCount / nonNull.length > 0.85) type = 'numeric';
    else if (dateCount / nonNull.length > 0.85) type = 'date';
    else type = 'categorical';

    const col = { name: key, type, missing, missingPct: +(missing / vals.length * 100).toFixed(1) };

    if (type === 'numeric') {
      const nums = nonNull.map(Number).filter(n => !isNaN(n));
      col.stats = numericStats(nums);
      numericCols.push(key);
    } else if (type === 'date') {
      const dates = nonNull.map(v => v instanceof Date ? v : new Date(v)).sort((a, b) => a - b);
      col.stats = { min: dates[0].toISOString().slice(0, 10), max: dates[dates.length - 1].toISOString().slice(0, 10) };
      dateCols.push(key);
    } else if (type === 'categorical') {
      const freq = {};
      nonNull.forEach(v => { const k = String(v); freq[k] = (freq[k] || 0) + 1; });
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      col.stats = { distinct: sorted.length, top: sorted.slice(0, 6) };
      categoricalCols.push(key);
    }
    columns.push(col);
  });

  const correlations = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const a = numericCols[i], b = numericCols[j];
      const pairs = rows.map(r => [r[a], r[b]]).filter(p => typeof p[0] === 'number' && typeof p[1] === 'number');
      if (pairs.length < 4) continue;
      const r = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
      if (!isNaN(r)) correlations.push({ a, b, r: +r.toFixed(3) });
    }
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  const insights = buildInsights(rows, columns, numericCols, categoricalCols, dateCols, correlations);

  return { rowCount: rows.length, columns, numericCols, categoricalCols, dateCols, correlations, insights };
}

function buildInsights(rows, columns, numericCols, categoricalCols, dateCols, correlations) {
  const list = [];
  const totalMissing = columns.reduce((a, c) => a + c.missing, 0);
  const totalCells = columns.length * rows.length;

  list.push({
    icon: 'summary',
    text: `This dataset has ${rows.length.toLocaleString()} rows and ${columns.length} columns. Overall data completeness is ${(100 - (totalCells ? totalMissing / totalCells * 100 : 0)).toFixed(1)}%.`,
    stamp: `Computed from ${rows.length} rows`
  });

  numericCols.forEach(col => {
    const s = columns.find(c => c.name === col).stats;
    list.push({
      icon: 'summary',
      text: `${col} ranges from ${fmt(s.min)} to ${fmt(s.max)}, averaging ${fmt(s.mean)} (median ${fmt(s.median)}). Standard deviation is ${fmt(s.std)}.`,
      stamp: `Computed from ${s.n} values`
    });
    if (s.outlierCount) {
      list.push({
        icon: 'outlier',
        text: `${s.outlierCount} value(s) in ${col} fall outside the typical range (beyond 1.5x the interquartile range) — worth a manual check before trusting averages built on this field.`,
        stamp: `IQR method on ${s.n} values`
      });
    }
  });

  if (dateCols.length) {
    numericCols.slice(0, 2).forEach(numCol => {
      const grouped = groupByDate(rows, dateCols[0], numCol);
      if (grouped.values.length >= 3) {
        const { slope } = linreg(grouped.values);
        const pct = grouped.values[0] ? (slope / grouped.values[0] * 100) : 0;
        const dir = slope > 0.0001 ? 'rising' : slope < -0.0001 ? 'falling' : 'roughly flat';
        list.push({
          icon: 'trend',
          text: `${numCol} is ${dir} over time, changing by about ${fmt(slope)} per period (roughly ${fmt(pct)}% per period based on ${grouped.values.length} periods of ${dateCols[0]}).`,
          stamp: `Linear fit on ${grouped.values.length} periods`
        });
      }
    });
  }

  correlations.slice(0, 2).forEach(c => {
    if (Math.abs(c.r) > 0.4) {
      const strength = Math.abs(c.r) > 0.7 ? 'strongly' : 'moderately';
      const dir = c.r > 0 ? 'move together' : 'move in opposite directions';
      list.push({
        icon: 'corr',
        text: `${c.a} and ${c.b} ${strength} ${dir} (correlation coefficient ${c.r}). This is an association, not proof that one causes the other.`,
        stamp: `Pearson r on paired values`
      });
    }
  });

  categoricalCols.forEach(col => {
    const s = columns.find(c => c.name === col).stats;
    // Skip identifier-like columns (e.g. an ID or Name field that's ~unique
    // per row) — "most common value, 0.1% of rows" isn't a useful insight,
    // it's just naming whichever row happened to be parsed first.
    const isIdentifierLike = rows.length > 0 && (s.distinct / rows.length) > 0.5;
    if (s.top.length && !isIdentifierLike) {
      const pct = (s.top[0][1] / rows.length * 100).toFixed(1);
      list.push({
        icon: 'summary',
        text: `"${s.top[0][0]}" is the most common value in ${col}, appearing in ${pct}% of rows out of ${s.distinct} distinct values.`,
        stamp: `Frequency count on ${rows.length} rows`
      });
    }
  });

  return list;
}

function computeForecast(rows, dateCol, metric, horizon) {
  const grouped = groupByDate(rows, dateCol, metric);
  if (grouped.values.length < 3) {
    return { error: 'Not enough time periods to project a reliable trend for this metric.' };
  }
  const { slope, intercept } = linreg(grouped.values);
  const n = grouped.values.length;
  const projected = [];
  for (let i = 0; i < horizon; i++) projected.push(+(intercept + slope * (n + i)).toFixed(2));

  const lastLabel = grouped.labels[grouped.labels.length - 1];
  const futureLabels = [];
  let d = new Date(lastLabel + '-01');
  for (let i = 0; i < horizon; i++) { d.setMonth(d.getMonth() + 1); futureLabels.push(d.toISOString().slice(0, 7)); }

  const direction = slope > 0 ? 'increase' : slope < 0 ? 'decrease' : 'stay flat';
  const summary = `Based on the last ${n} periods, ${metric} is projected to ${direction} by roughly ${fmt(Math.abs(slope))} per period, reaching about ${fmt(projected[projected.length - 1])} by ${futureLabels[futureLabels.length - 1]}. This is a simple straight-line projection of past data — it does not account for seasonality, promotions, or one-off events. Treat it as directional, and treat the furthest-out points as the least certain.`;

  return { metric, horizon, dateCol, historicalLabels: grouped.labels, historicalValues: grouped.values, futureLabels, projected, slope, summary };
}

// Normalizes a join key for matching so "123" (string) and 123 (number), or
// values with stray whitespace/casing, still match correctly.
function normalizeJoinKey(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim().toLowerCase();
}

// Merges a matched row pair. Columns unique to B are added as-is; columns
// that collide with A's names (other than the join column itself) are
// prefixed with the B dataset's label so nothing silently overwrites data.
function mergeRow(rowA, rowB, labelB, colB) {
  const merged = { ...rowA };
  Object.keys(rowB).forEach(k => {
    if (k === colB) return; // same join key as colA, already present
    merged[(k in merged) ? `${labelB}_${k}` : k] = rowB[k];
  });
  return merged;
}

// Inner-joins two row sets on the given columns. Every match becomes one
// row (a duplicate key on either side produces one merged row per pair, the
// standard SQL join behavior) — the returned stats make that visible rather
// than silently multiplying or dropping rows without explanation.
function joinDatasets(rowsA, colA, rowsB, colB, labelB) {
  const indexB = new Map();
  rowsB.forEach(r => {
    const key = normalizeJoinKey(r[colB]);
    if (key === null) return;
    if (!indexB.has(key)) indexB.set(key, []);
    indexB.get(key).push(r);
  });

  const matchedBKeys = new Set();
  const joinedRows = [];
  let duplicateKeyGroups = 0;

  rowsA.forEach(rowA => {
    const key = normalizeJoinKey(rowA[colA]);
    const matches = key !== null ? indexB.get(key) : undefined;
    if (matches && matches.length) {
      if (matches.length > 1) duplicateKeyGroups++;
      matchedBKeys.add(key);
      matches.forEach(rowB => joinedRows.push(mergeRow(rowA, rowB, labelB, colB)));
    }
  });

  const unmatchedA = rowsA.filter(r => {
    const key = normalizeJoinKey(r[colA]);
    return key === null || !indexB.has(key);
  }).length;

  const unmatchedB = rowsB.filter(r => {
    const key = normalizeJoinKey(r[colB]);
    return key === null || !matchedBKeys.has(key);
  }).length;

  return {
    rows: joinedRows,
    stats: {
      rowsA: rowsA.length,
      rowsB: rowsB.length,
      matchedRows: joinedRows.length,
      unmatchedA,
      unmatchedB,
      duplicateKeyGroups
    }
  };
}

module.exports = { profileRows, computeForecast, groupByDate, linreg, fmt, joinDatasets };
