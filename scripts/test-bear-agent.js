'use strict';

/**
 * Manual smoke test for the Bear Agent.
 * Run with:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-bear-agent.js
 *
 * Two scenarios are tested back-to-back:
 *   1. DANGER scenario  — overbought RSI, extreme greed, elevated funding,
 *                         price sitting directly under a prior rejection level.
 *                         Expected: high bear score (70+).
 *
 *   2. CLEAN scenario   — oversold RSI, neutral MACD, low Fear & Greed,
 *                         no nearby resistance.
 *                         Expected: low bear score (0-30).
 */

const { analyseRound1 } = require('../agents/bear/index.js');

// ── Scenario 1: Everything screams danger ────────────────────────────────────
const dangerousSetup = {
  asset:                 'BTC/USDT',
  currentPrice:          97_800,
  rsi:                   78,                  // overbought
  macd:                  'bullish_crossover',  // late signal — momentum may be exhausted
  fundingRate:           0.0018,              // very elevated (longs crowded)
  fearGreedIndex:        84,                  // extreme greed
  recentRejectionLevels: [98_500, 100_000],   // both above current price, 0.7% and 2.2% away
};

// ── Scenario 2: Clean setup, thin bear case ──────────────────────────────────
const cleanSetup = {
  asset:                 'ETH/USDT',
  currentPrice:          3_100,
  rsi:                   34,                  // near oversold — bounce risk
  macd:                  'neutral',
  fundingRate:           0.0001,              // near-zero, no crowding
  fearGreedIndex:        28,                  // fear — not euphoric
  recentRejectionLevels: [3_800, 4_200],      // resistance is far away (22%+ above)
};

async function run() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' Bear Agent — smoke test');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Test 1 ────────────────────────────────────────────────────────────────
  console.log('▶  Scenario 1: DANGER setup (expect high score 70+)');
  console.log('   RSI 78 | funding 0.18% | FGI 84 | resistance $98,500 (+0.7%)\n');

  let result1;
  try {
    result1 = await analyseRound1(dangerousSetup);
  } catch (err) {
    console.error('✗ Scenario 1 FAILED:', err.message);
    process.exit(1);
  }

  console.log('\n── Scenario 1 result ──────────────────────────────────');
  console.log(JSON.stringify(result1, null, 2));

  const s1Pass = result1.score >= 60;
  console.log(`\n${s1Pass ? '✓' : '⚠'} Score ${result1.score} — ${s1Pass ? 'PASS (bearish conviction as expected)' : 'NOTE: lower than expected for this setup'}`);

  // ── Test 2 ────────────────────────────────────────────────────────────────
  console.log('\n\n▶  Scenario 2: CLEAN setup (expect low score 0-30)');
  console.log('   RSI 34 | funding 0.01% | FGI 28 | resistance $3,800 (+22%)\n');

  let result2;
  try {
    result2 = await analyseRound1(cleanSetup);
  } catch (err) {
    console.error('✗ Scenario 2 FAILED:', err.message);
    process.exit(1);
  }

  console.log('\n── Scenario 2 result ──────────────────────────────────');
  console.log(JSON.stringify(result2, null, 2));

  const s2Pass = result2.score <= 40;
  console.log(`\n${s2Pass ? '✓' : '⚠'} Score ${result2.score} — ${s2Pass ? 'PASS (thin bear case as expected)' : 'NOTE: higher than expected for a clean setup'}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' Shape check (both results must pass)');
  console.log('═══════════════════════════════════════════════════════');

  for (const [label, result] of [['Scenario 1', result1], ['Scenario 2', result2]]) {
    const shapeOk =
      typeof result.score  === 'number' &&
      typeof result.thesis === 'string' &&
      typeof result.data   === 'object';
    console.log(`  ${shapeOk ? '✓' : '✗'} ${label}: { score: ${typeof result.score}, thesis: ${typeof result.thesis}, data: ${typeof result.data} }`);
  }

  const inverseCorrOk = result1.score > result2.score;
  console.log(`  ${inverseCorrOk ? '✓' : '✗'} Inverse correlation: danger score (${result1.score}) > clean score (${result2.score})`);

  console.log('\nDone.\n');
}

run();
