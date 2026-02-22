'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OctoBot dispatcher — sends approved trade instructions to the OctoBot webhook.
//
// OctoBot is a separate Docker container (see /octobot/docker-compose.yml)
// running in paper trading mode. It receives trade instructions via its internal
// webhook API and executes them on the Binance testnet.
//
// OCTOBOT_WEBHOOK_URL is set as a Railway environment variable and points to the
// OctoBot container's webhook endpoint (e.g. http://octobot:5001/commands).
//
// Phase 1: scaffold — logs the instruction and sends to OCTOBOT_WEBHOOK_URL.
// Phase 2: parse OctoBot response, update the trades row with exchange fill data.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── executeTrade ──────────────────────────────────────────────────────────────
/**
 * Dispatches an approved trade instruction to the OctoBot webhook.
 *
 * @param {object} tradeInstruction
 * @param {string} tradeInstruction.tradeId          — UUID from the trades table
 * @param {string} tradeInstruction.deliberationId   — UUID from the deliberations table
 * @param {string} tradeInstruction.asset            — e.g. 'BTC/USDT'
 * @param {string} tradeInstruction.direction        — 'long' | 'short' | 'close'
 * @param {number} tradeInstruction.positionSizePct  — approved size as % of portfolio
 * @param {number} tradeInstruction.positionSizeUsd  — approved size in USD
 * @param {number} tradeInstruction.entryPrice       — price at signal receipt time
 *
 * @returns {Promise<void>}
 */
async function executeTrade(tradeInstruction) {
  const octobotUrl = process.env.OCTOBOT_WEBHOOK_URL;

  console.log(
    `[octobot] Dispatching trade — ` +
    `tradeId=${tradeInstruction.tradeId} ` +
    `asset=${tradeInstruction.asset} ` +
    `direction=${tradeInstruction.direction} ` +
    `size=$${tradeInstruction.positionSizeUsd} (${tradeInstruction.positionSizePct}%)`,
  );

  // Build the payload OctoBot expects.
  // Phase 2: align field names with the OctoBot webhook schema once integration is live.
  const body = JSON.stringify({
    trade_id:          tradeInstruction.tradeId,
    deliberation_id:   tradeInstruction.deliberationId,
    asset:             tradeInstruction.asset,
    direction:         tradeInstruction.direction,
    position_size_pct: tradeInstruction.positionSizePct,
    position_size_usd: tradeInstruction.positionSizeUsd,
    entry_price:       tradeInstruction.entryPrice,
    mode:              process.env.RAILWAY_ENVIRONMENT === 'live' ? 'live' : 'paper',
  });

  try {
    await postJson(octobotUrl, body);
    console.log(
      `[octobot] Trade dispatched successfully — tradeId=${tradeInstruction.tradeId}`,
    );
  } catch (err) {
    // Log and rethrow — the webhook layer catches this and logs it separately.
    console.error(
      `[octobot] Failed to dispatch trade ${tradeInstruction.tradeId}: ${err.message}`,
    );
    throw err;
  }
}


// ── postJson ──────────────────────────────────────────────────────────────────
// Minimal HTTP/HTTPS POST using Node built-ins — no axios dependency.
// Resolves when the response status is 2xx; rejects otherwise.

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error(`[octobot] Invalid OCTOBOT_WEBHOOK_URL: ${urlString}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(
            `[octobot] OctoBot responded with HTTP ${res.statusCode}: ${data}`,
          ));
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(10_000, () => {
      req.destroy(new Error('[octobot] Request to OctoBot timed out after 10s'));
    });

    req.write(body);
    req.end();
  });
}


module.exports = { executeTrade };
