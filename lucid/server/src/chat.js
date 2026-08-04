const express = require('express');
const db = require('./db');
const storage = require('./storage');
const { requireAuth } = require('./auth');

const router = express.Router();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildSystemPrompt(context) {
  return `You are Lucid, a careful data analyst assistant embedded in a dashboard app.
You must answer ONLY using the CONTEXT JSON provided below, which contains real computed statistics, correlations, insights, a forecast (if generated), and a small row sample from the user's uploaded dataset.
Rules:
- Never invent numbers, columns, or facts that are not present in CONTEXT.
- If the answer requires data not present in CONTEXT, say clearly that you don't have enough information to answer that, and suggest what data would help.
- When you cite a figure, it must come directly from CONTEXT (computed stats, correlations, or forecast). Round sensibly and mention units/columns clearly.
- When discussing the forecast or the future, always caveat that it is a simple linear projection of past data and not a guarantee, and note that uncertainty grows further into the future.
- Explain things in plain, non-technical language a business owner would understand. Be concise: 2-5 sentences unless asked for more detail.
- When useful, end with a concrete, actionable next step grounded in the data.
- Do not speculate about causes beyond what correlations/trends in CONTEXT support; be explicit that correlation is not causation.

CONTEXT:
${JSON.stringify(context)}`;
}

// Rate limiting: simple in-memory sliding window per user. Fine for a
// single-process MVP; swap for a Redis-backed limiter once you scale past
// one server instance.
const RATE_LIMIT = 20; // messages
const RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
const hits = new Map();

function rateLimited(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(userId, arr);
  return arr.length > RATE_LIMIT;
}

router.get('/:datasetId/chat', requireAuth, (req, res) => {
  const dataset = db.getDataset(req.params.datasetId, req.user.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });
  res.json(db.listChatMessages(dataset.id));
});

router.post('/:datasetId/chat', requireAuth, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server is not configured with an Anthropic API key.' });
    if (rateLimited(req.user.id)) return res.status(429).json({ error: 'Too many messages — please wait a bit before asking again.' });

    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const dataset = db.getDataset(req.params.datasetId, req.user.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });

    const rows = storage.loadRows(req.user.id, dataset.id) || [];
    const context = {
      datasetName: dataset.name,
      rowCount: dataset.rowCount,
      columns: JSON.parse(dataset.columnsJson),
      correlations: JSON.parse(dataset.correlationsJson).slice(0, 5),
      computedInsights: JSON.parse(dataset.insightsJson).map(i => i.text),
      forecast: dataset.forecastJson ? JSON.parse(dataset.forecastJson) : null,
      sampleRows: rows.slice(0, 5)
    };

    const history = db.listChatMessages(dataset.id);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: buildSystemPrompt(context),
        messages: [...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: message }]
      })
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errBody);
      return res.status(502).json({ error: 'The analysis engine is unavailable right now. Please try again shortly.' });
    }

    const data = await anthropicRes.json();
    const answer = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || "I couldn't generate a response — please try rephrasing your question.";

    db.addChatMessages(dataset.id, [
      { role: 'user', content: message },
      { role: 'assistant', content: answer }
    ]);

    res.json({ role: 'assistant', content: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong reaching the analysis engine.' });
  }
});

module.exports = router;
