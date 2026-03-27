/**
 * One-time backfill: pulls all historical FUB calls and runs them
 * through the transcription + analysis pipeline.
 *
 * Usage: node utils/backfill.js [--days=30]
 * This will consume OpenAI + Anthropic API credits proportional to call volume.
 */
require('dotenv').config();
const { getRecentCalls } = require('../db/followupboss');
const { handleCallCompleted } = require('../routes/webhooks');
const { log } = require('./logger');

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '7');
const DELAY_MS = 2000; // Rate limit buffer between calls

async function backfill() {
  log('info', `Starting backfill for last ${DAYS} days...`);
  const calls = await getRecentCalls({ limit: 200 });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  const recent = calls.filter(c => {
    const d = new Date(c.created || c.updatedAt);
    return d >= cutoff && c.recordingUrl && (c.duration || 0) >= 30;
  });

  log('info', `Found ${recent.length} calls to process`);

  for (let i = 0; i < recent.length; i++) {
    const call = recent[i];
    log('info', `[${i + 1}/${recent.length}] Processing call ${call.id} — ${call.duration}s`);
    try {
      await handleCallCompleted({
        id: call.id,
        personId: call.personId,
        userId: call.userId,
        duration: call.duration,
        recordingUrl: call.recordingUrl,
        created: call.created
      });
    } catch (err) {
      log('error', `Failed on call ${call.id}: ${err.message}`);
    }
    if (i < recent.length - 1) await sleep(DELAY_MS);
  }

  log('info', 'Backfill complete.');
  process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

backfill().catch(e => { console.error(e); process.exit(1); });
