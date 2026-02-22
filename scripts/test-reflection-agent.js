'use strict';

/**
 * Manual test for the Reflection Agent.
 * Run with:
 *   ANTHROPIC_API_KEY=sk-ant-... SUPABASE_URL=https://... SUPABASE_SERVICE_KEY=... node scripts/test-reflection-agent.js
 *
 * This script manually triggers the weekly reflection process.
 * Requires at least one closed trade in the past 7 days in the Supabase database.
 *
 * NOTE: This will write to agent_reputation and reflections tables.
 */

require('dotenv').config();

const { runWeeklyReflection } = require('./reflection-agent.js');

async function run() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' Reflection Agent — manual test');
  console.log('═══════════════════════════════════════════════════════\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('✗ ANTHROPIC_API_KEY not set. Exiting.');
    process.exit(1);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('✗ SUPABASE_URL or SUPABASE_SERVICE_KEY not set. Exiting.');
    process.exit(1);
  }

  console.log('▶  Running weekly reflection...\n');

  try {
    await runWeeklyReflection();
  } catch (err) {
    console.error('\n✗ Reflection failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  console.log('\n✓ Reflection completed successfully.');
  console.log('\nCheck Supabase tables:');
  console.log('  - agent_reputation (updated weights per agent)');
  console.log('  - reflections (full weekly summary)\n');
}

run();
