const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const db = require('./db');
const storage = require('./storage');
const { requireAuth } = require('./auth');
const { profileRows, computeForecast } = require('./profiling');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB cap for MVP
  fileFilter: (req, file, cb) => {
    if (!/\.(csv|tsv|xlsx|xls)$/i.test(file.originalname)) {
      const err = new Error(`"${file.originalname}" isn't a supported file type. Upload a .csv, .tsv, .xlsx, or .xls file.`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

// Parses an uploaded file's buffer into an array of row objects, based on
// its extension. CSV/TSV go through PapaParse; Excel workbooks go through
// SheetJS. Only the FIRST sheet of a workbook is used — a workbook with
// several sheets of related data is exactly what the "Combine Data" tab is
// for: upload it, then re-upload for each sheet you need (SheetJS doesn't
// give a clean way to let the browser pick a sheet before parsing without a
// second round trip, so this keeps the single-upload flow simple for now).
function parseRows(buffer, originalname) {
  const isExcel = /\.(xlsx|xls)$/i.test(originalname);
  if (isExcel) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new Error('This workbook has no sheets.');
    const sheet = workbook.Sheets[firstSheetName];
    // raw:true keeps numbers as numbers and (with cellDates above) dates as
    // real JS Date objects, matching what PapaParse's dynamicTyping gives us
    // for CSVs — so profileRows() doesn't need to know which format it got.
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
    return { rows, sheetName: firstSheetName, sheetCount: workbook.SheetNames.length };
  }

  const text = buffer.toString('utf8');
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length) {
    const fatal = parsed.errors.filter(e => e.type !== 'FieldMismatch');
    if (fatal.length) throw new Error('Could not parse file: ' + fatal[0].message);
  }
  return { rows: parsed.data, sheetName: null, sheetCount: null };
}

// Rows are capped for the in-response payload so the browser dashboard stays
// snappy. Full stats/insights are always computed on the complete file first;
// only the row sample sent back to the client (for charts) is capped.
const MAX_ROWS_RETURNED = 5000;

router.post('/upload', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send it as multipart field "file".' });

    let parsedRows, sheetInfo;
    try {
      const result = parseRows(req.file.buffer, req.file.originalname);
      parsedRows = result.rows;
      sheetInfo = result.sheetCount > 1 ? { sheetName: result.sheetName, sheetCount: result.sheetCount } : null;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let profile;
    try {
      profile = profileRows(parsedRows);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const datasetId = db.createDataset(req.user.id, profile, req.file.originalname);

    const rawPath = storage.saveRaw(req.user.id, datasetId, req.file.originalname, req.file.buffer);
    storage.saveRows(req.user.id, datasetId, parsedRows);
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
      sheetInfo,
      rows: parsedRows.slice(0, MAX_ROWS_RETURNED)
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
    joinInfo: dataset.joinInfoJson ? JSON.parse(dataset.joinInfoJson) : null,
    cleaningInfo: dataset.cleaningInfoJson ? JSON.parse(dataset.cleaningInfoJson) : null,
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
