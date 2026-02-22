'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Webhook handler — receives and validates TradingView alerts.
//
// This module does NOT start its own HTTP server. It exports handleRequest()
// which is mounted by the root index.js server. Environment variable validation
// and server lifecycle are owned by the root entry point.
//
// Flow per request:
//   1. Accept POST /webhook/tradingview only (all other paths → 404)
//   2. Validate TRADINGVIEW_WEBHOOK_SECRET (query param or JSON body field)
//   3. Validate required payload fields (asset, direction)
//   4. Write signal row to Supabase signals table
//   5. Acknowledge TradingView with 200 immediately
//   6. Trigger deliberation pipeline asynchronously (non-blocking)
//   7. If deliberation approves a trade, dispatch to OctoBot
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const { runDeliberation } = require('../orchestrator/index.js');
const { executeTrade }    = require('../octobot/index.js');

// ── Supabase client ───────────────────────────────────────────────────────────
// Lazily initialised so the module can be imported without env vars fully set.

let supabase = null;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return supabase;
}


// ── Request body reader ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end',  () => resolve(raw));
    req.on('error', reject);
  });
}


// ── Payload validator ─────────────────────────────────────────────────────────
// Checks that the parsed payload contains the fields required by the signals schema.
// Returns { valid: boolean, errors: string[] }

function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload is not a JSON object'] };
  }

  if (!payload.asset || typeof payload.asset !== 'string') {
    errors.push('Missing or invalid field: asset (string required, e.g. BTC/USDT)');
  }

  const validDirections = ['long', 'short', 'close'];
  if (!payload.direction || !validDirections.includes(payload.direction)) {
    errors.push(`Missing or invalid field: direction (must be one of: ${validDirections.join(', ')})`);
  }

  return { valid: errors.length === 0, errors };
}


// ── Signal writer ─────────────────────────────────────────────────────────────
// Maps the validated payload to the signals table schema and writes to Supabase.

async function writeSignal(payload) {
  const record = {
    asset:       payload.asset,
    direction:   payload.direction,
    timeframe:   payload.timeframe   || null,
    signal_type: payload.signal_type || null,
    raw_payload: payload,
  };

  const { data, error } = await getSupabase()
    .from('signals')
    .insert(record)
    .select('id, received_at, asset, direction')
    .single();

  if (error) throw error;
  return data;
}


// ── Orchestrator + OctoBot dispatch ───────────────────────────────────────────
// Runs the full deliberation pipeline and, if approved, sends the trade
// instruction to OctoBot. Called after the 200 response is sent so TradingView
// never waits on the agent pipeline. Errors must not propagate to the HTTP layer.

async function runPipelineAsync(signalId) {
  console.log(`[webhook] Triggering deliberation pipeline for signal ${signalId}`);

  let result;
  try {
    result = await runDeliberation(signalId);
  } catch (err) {
    console.error(`[webhook] Deliberation failed for signal ${signalId}:`, err.message);
    return;
  }

  console.log(
    `[webhook] Deliberation complete — signal=${signalId} ` +
    `decision=${result.decision} elapsedMs=${result.elapsedMs}`,
  );

  if (result.tradeInstruction) {
    try {
      await executeTrade(result.tradeInstruction);
    } catch (err) {
      console.error(
        `[webhook] OctoBot dispatch failed for signal ${signalId}:`, err.message,
      );
    }
  }
}


// ── handleRequest ─────────────────────────────────────────────────────────────
// Exported for mounting by the root index.js server.
// Handles POST /webhook/tradingview; returns 404 for all other paths.

async function handleRequest(req, res) {
  const url = req.url.split('?')[0]; // strip query string for route matching

  if (req.method !== 'POST' || url !== '/webhook/tradingview') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── Read body ──────────────────────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    console.error('[webhook] Failed to read request body:', err.message);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not read request body' }));
    return;
  }

  // ── Parse JSON ─────────────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn('[webhook] Rejected request — body is not valid JSON');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // ── Secret validation ──────────────────────────────────────────────────────
  // TradingView sends the secret as a query param (?secret=...) or inside the
  // JSON body. Support both patterns so free (email-parsed) and paid webhook
  // plans work without separate handling.
  const urlParams       = new URL(req.url, 'http://localhost').searchParams;
  const secretFromQuery = urlParams.get('secret');
  const secretFromBody  = payload.secret;
  const receivedSecret  = secretFromQuery || secretFromBody;

  const WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET;

  if (receivedSecret !== WEBHOOK_SECRET) {
    console.warn('[webhook] Rejected request — invalid or missing secret');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorised' }));
    return;
  }

  // Never persist the secret to Supabase.
  delete payload.secret;

  // ── Payload validation ─────────────────────────────────────────────────────
  const { valid, errors } = validatePayload(payload);
  if (!valid) {
    console.warn('[webhook] Rejected payload — validation failed:', errors);
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload validation failed', details: errors }));
    return;
  }

  // ── Write signal to Supabase ───────────────────────────────────────────────
  let signal;
  try {
    signal = await writeSignal(payload);
    console.log(
      `[webhook] Signal logged — id=${signal.id} asset=${signal.asset} ` +
      `direction=${signal.direction} at=${signal.received_at}`,
    );
  } catch (err) {
    console.error('[webhook] Failed to write signal to Supabase:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to persist signal' }));
    return;
  }

  // ── Acknowledge TradingView ────────────────────────────────────────────────
  // Respond immediately so TradingView never times out waiting on the agent pipeline.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ received: true, signal_id: signal.id }));

  // ── Trigger pipeline asynchronously ───────────────────────────────────────
  // runPipelineAsync handles its own errors — the webhook handler is done.
  runPipelineAsync(signal.id).catch(err => {
    console.error(`[webhook] Pipeline error for signal ${signal.id}:`, err.message);
  });
}


module.exports = { handleRequest };
