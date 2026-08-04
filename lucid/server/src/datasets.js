const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const db = require('./db');
const storage = require('./storage');
const { requireAuth } = require('./auth');
const { profileRows, computeForecast } = require('./profiling');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB cap for MVP

// Rows are capped for the in-response payload so the browser dashboard stays
// snappy. Full stats/insights are always computed on the complete file first;
// only the row sample sent back to the client (for charts) is capped.
const MAX_ROWS_RETURNED = 5000;

router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send it as multipart field "file".' });

    const text = req.file.buffer.toString('utf8');
    const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
    if (parsed.errors && parsed.errors.length) {
      const fatal = parsed.errors.filter(e => e.type !== 'FieldMismatch');
      if (fatal.length) return res.status(400).json({ error: 'Could not parse file: ' + fatal[0].message });
    }

    let profile;
    try {
      profile = profileRows(parsed.data);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const datasetId = db.createDataset(req.user.id, profile, req.file.originalname);

    const rawPath = storage.saveRaw(req.user.id, datasetId, req.file.originalname, req.file.buffer);
    storage.saveRows(req.user.id, datasetId, parsed.data);
    db.setDatasetFilePath(datasetId, rawPath);

    res.json({
      id: datasetId,
      name: req.file.originalname,
      rowCount: profile.rowCount,
      columns: profile.columns,
      numericCols: profile.numericCols,
      categoricalCols: profile.categoricalCols,
      dateCols: profile.dateCols,
      correlations: profile.correlations,
      insights: profile.insights,
      rows: parsed.data.slice(0, MAX_ROWS_RETURNED)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

router.get('/', requireAuth, (req, res) => {
  res.json(db.listDatasets(req.user.id));
});

router.get('/:id', requireAuth, (req, res) => {
  const dataset = db.getDataset(req.params.id, req.user.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });

  const rows = storage.loadRows(req.user.id, dataset.id) || [];
  res.json({
    id: dataset.id,
    name: dataset.name,
    rowCount: dataset.rowCount,
    columns: JSON.parse(dataset.columnsJson),
    numericCols: JSON.parse(dataset.numericColsJson),
    categoricalCols: JSON.parse(dataset.categoricalColsJson),
    dateCols: JSON.parse(dataset.dateColsJson),
    correlations: JSON.parse(dataset.correlationsJson),
    insights: JSON.parse(dataset.insightsJson),
    forecast: dataset.forecastJson ? JSON.parse(dataset.forecastJson) : null,
    rows: rows.slice(0, MAX_ROWS_RETURNED)
  });
});

router.post('/:id/forecast', requireAuth, (req, res) => {
  const dataset = db.getDataset(req.params.id, req.user.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });

  const { metric, horizon } = req.body || {};
  const dateCols = JSON.parse(dataset.dateColsJson);
  if (!metric || !dateCols.length) return res.status(400).json({ error: 'This dataset has no date column to forecast against.' });

  const rows = storage.loadRows(req.user.id, dataset.id) || [];
  const result = computeForecast(rows, dateCols[0], metric, Math.min(Math.max(+horizon || 6, 1), 24));
  if (result.error) return res.status(400).json({ error: result.error });

  db.setDatasetForecast(dataset.id, JSON.stringify(result));
  res.json(result);
});

module.exports = router;
