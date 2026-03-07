'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Analyst Chat Handler — upgraded to 3-layer intelligent context
//
// Layer 1: Institutional memory (SwarmTrade architecture + risk philosophy)
// Layer 2: Live Supabase context (deliberations, sentiment, positions, news)
// Layer 3: Web search (Anthropic web_search tool — Claude decides when to use)
//
// POST /analyst/chat
// Body: { messages: [{role, content}] }
// Returns: { content: string }
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic             = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./systemPrompt');
const { fetchLiveContext }  = require('./liveContext');

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

  const { messages } = body;
  if (!messages || !Array.isArray(messages)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }

  try {
    // ── Layer 2: Fetch live context in parallel before building prompt ──────
    const liveContext  = await fetchLiveContext();
    const systemPrompt = buildSystemPrompt(liveContext);

    // ── Layers 1+2+3: Call Sonnet with full context + web search ────────────
    const response = await getClient().messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system:     systemPrompt,
      messages,
      tools: [
        {
          type: 'web_search_20250305',  // Layer 3: world awareness
          name: 'web_search',
        },
      ],
    });

    // Collect all text blocks (web search may produce multiple content blocks)
    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    console.log(`[analyst] Response — stop_reason=${response.stop_reason} blocks=${response.content.length} chars=${content.length}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content }));

  } catch (err) {
    console.error('[analyst] Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = { handleAnalystChat };
