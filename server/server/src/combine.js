const express = require('express');
const db = require('./db');
const storage = require('./storage');
const { requireAuth } = require('./auth');
const { profileRows, joinDatasets } = require('./profiling');

const router = express.Router();

router.post('/combine', requireAuth, (req, res) => {
  try {
    const { datasetAId, columnA, datasetBId, columnB, name } = req.body || {};
    if (!datasetAId || !columnA || !datasetBId || !columnB) {
      return res.status(400).json({ error: 'datasetAId, columnA, datasetBId, and columnB are all required.' });
    }
    if (datasetAId === datasetBId) {
      return res.status(400).json({ error: 'Pick two different datasets to combine.' });
    }

    // Ownership check on both sides — a user can only combine their own data.
    const datasetA = db.getDataset(datasetAId, req.user.id);
    const datasetB = db.getDataset(datasetBId, req.user.id);
    if (!datasetA || !datasetB) return res.status(404).json({ error: 'One or both datasets were not found.' });

    const rowsA = storage.loadRows(req.user.id, datasetA.id) || [];
    const rowsB = storage.loadRows(req.user.id, datasetB.id) || [];
    if (!rowsA.length || !rowsB.length) {
      return res.status(400).json({ error: 'One or both datasets have no rows to combine.' });
    }

    const labelB = datasetB.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 30) || 'b';
    const { rows: joinedRows, stats: joinStats } = joinDatasets(rowsA, columnA, rowsB, columnB, labelB);

    if (!joinedRows.length) {
      return res.status(400).json({
        error: `No rows matched between "${columnA}" and "${columnB}" — double-check you picked the columns that actually correspond to the same real-world thing (e.g. both are customer IDs).`
      });
    }

    const profile = profileRows(joinedRows);
    const combinedName = name || `${datasetA.name} + ${datasetB.name} (joined)`;
    const joinInfo = {
      datasetAId: datasetA.id, datasetAName: datasetA.name, columnA,
      datasetBId: datasetB.id, datasetBName: datasetB.name, columnB,
      ...joinStats
    };

    const newDatasetId = db.createDataset(req.user.id, profile, combinedName, joinInfo);
    storage.saveRows(req.user.id, newDatasetId, joinedRows);

    res.json({
      id: newDatasetId,
      name: combinedName,
      rowCount: profile.rowCount,
      columns: profile.columns,
      numericCols: profile.numericCols,
      categoricalCols: profile.categoricalCols,
      dateCols: profile.dateCols,
      correlations: profile.correlations,
      insights: profile.insights,
      joinInfo,
      rows: joinedRows.slice(0, 5000)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not combine these datasets.' });
  }
});

module.exports = router;
