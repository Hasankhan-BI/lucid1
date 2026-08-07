const express = require('express');
const db = require('./db');
const storage = require('./storage');
const { requireAuth } = require('./auth');
const { profileRows, applyCleaning } = require('./profiling');

const router = express.Router();

router.post('/:id/clean', requireAuth, (req, res) => {
  try {
    const dataset = db.getDataset(req.params.id, req.user.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });

    const rows = storage.loadRows(req.user.id, dataset.id) || [];
    if (!rows.length) return res.status(400).json({ error: 'This dataset has no rows to clean.' });

    // Profile the ORIGINAL data first — its stats (mean/median/mode/IQR
    // bounds) are what drive the cleaning operations below.
    const originalProfile = profileRows(rows);
    const options = req.body || {};
    const { rows: cleanedRows, report } = applyCleaning(rows, originalProfile.columns, options);

    if (!cleanedRows.length) {
      return res.status(400).json({
        error: 'These options would remove every row — try something less aggressive, like filling missing values instead of dropping those rows.'
      });
    }

    const cleanedProfile = profileRows(cleanedRows);
    const cleanedName = options.name || `${dataset.name} (cleaned)`;
    const cleaningInfo = { sourceDatasetId: dataset.id, sourceDatasetName: dataset.name, options, report };

    const newDatasetId = db.createDataset(req.user.id, cleanedProfile, cleanedName, null, cleaningInfo);
    storage.saveRows(req.user.id, newDatasetId, cleanedRows);

    res.json({
      id: newDatasetId,
      name: cleanedName,
      rowCount: cleanedProfile.rowCount,
      columns: cleanedProfile.columns,
      numericCols: cleanedProfile.numericCols,
      categoricalCols: cleanedProfile.categoricalCols,
      dateCols: cleanedProfile.dateCols,
      correlations: cleanedProfile.correlations,
      insights: cleanedProfile.insights,
      cleaningInfo,
      rows: cleanedRows.slice(0, 5000)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not clean this dataset.' });
  }
});

module.exports = router;
