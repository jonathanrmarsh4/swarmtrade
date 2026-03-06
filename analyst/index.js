'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Analyst proxy — receives chat messages from the dashboard and forwards
// them to the Anthropic API server-side (avoids CORS restrictions).
//
// POST /analyst/chat
// Body: { messages: [{role, content}], system: string }
// Returns: { content: string }
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end',  () => resolve(raw));
    req.on('error', reject);
  });
}

async function handleAnalystChat(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const { messages, system } = body;
  if (!messages || !Array.isArray(messages)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }

  try {
    const response = await getClient().messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     system ?? '',
      messages,
    });

    const content = response.content?.[0]?.text ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content }));
  } catch (err) {
    console.error('[analyst] Anthropic API error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = { handleAnalystChat };
