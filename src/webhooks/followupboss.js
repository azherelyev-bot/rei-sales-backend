/**
 * FollowUp Boss Webhook Handler
 * 
 * FUB sends events to this endpoint for:
 *   - callCompleted  → transcribe + analyze with Claude
 *   - personCreated  → record speed-to-lead when first call is made
 *   - noteCreated    → activity tracking
 * 
 * Set this URL in FUB: Admin > Integrations > Webhooks
 */
import express from 'express';
import crypto from 'crypto';
import { transcribeCall } from '../services/transcription.js';
import { analyzeCall } from '../services/callAnalyzer.js';
import { recordCallEvent, recordLeadCreated } from '../services/metricsAggregator.js';
import { supabase } from '../services/supabase.js';

export const webhookRouter = express.Router();

// Verify FUB webhook signature (set FUB_WEBHOOK_SECRET in FUB dashboard)
function verifySignature(req) {
  const secret = process.env.FUB_WEBHOOK_SECRET;
  if (!secret) return true; // skip in dev if not set
  const sig = req.headers['x-followupboss-signature'];
  if (!sig) return false;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return sig === `sha256=${hmac}`;
}

webhookRouter.post('/followupboss', async (req, res) => {
  // Always ack immediately — FUB expects 200 within 5s
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  res.status(200).json({ received: true });

  // Process async so we never block the webhook response
  processEvent(req.body).catch(err =>
    console.error('[WEBHOOK] Processing error:', err.message)
  );
});

async function processEvent(payload) {
  const { event, data } = payload;
  console.log(`[WEBHOOK] Event: ${event}`, data?.id || '');

  switch (event) {
    case 'callCompleted':
      await handleCallCompleted(data);
      break;
    case 'personCreated':
    case 'personUpdated':
      await handlePersonEvent(data);
      break;
    case 'appointmentCreated':
      await handleAppointmentCreated(data);
      break;
    default:
      // Log unhandled events for future use
      console.log(`[WEBHOOK] Unhandled event type: ${event}`);
  }
}

// ---- CALL COMPLETED ----
async function handleCallCompleted(data) {
  const {
    id: callId,
    personId,
    userId,          // FUB rep ID
    duration,        // seconds
    recordingUrl,
    direction,       // inbound | outbound
    outcome,
    createdAt,
    to,
    from
  } = data;

  console.log(`[CALL] Processing call ${callId} | Rep: ${userId} | Duration: ${duration}s`);

  // Skip very short calls (<15s) — likely no-answers or voicemails
  if (duration < 15 && !recordingUrl) {
    await recordCallEvent({
      callId, personId, userId, duration, direction,
      outcome: outcome || 'no_answer', createdAt,
      leadScore: null, coachingNotes: null
    });
    return;
  }

  // Get rep info from FUB
  const rep = await getFUBUser(userId);
  const lead = await getFUBPerson(personId);

  // Calculate speed to lead (minutes from lead creation to first call)
  const speedToLead = await calculateSpeedToLead(personId, createdAt);

  let transcript = null;
  let analysis = null;

  // Transcribe if recording available
  if (recordingUrl) {
    try {
      console.log(`[TRANSCRIPTION] Starting for call ${callId}...`);
      transcript = await transcribeCall(recordingUrl, callId);
      console.log(`[TRANSCRIPTION] Complete — ${transcript.length} chars`);

      // Analyze with Claude
      console.log(`[ANALYSIS] Analyzing call ${callId} with Claude...`);
      analysis = await analyzeCall({
        transcript,
        repName: rep?.name || 'Unknown Rep',
        leadName: lead?.name || 'Unknown Lead',
        duration,
        direction,
        outcome
      });
      console.log(`[ANALYSIS] Complete — Score: ${analysis.leadScore}/5, Grade: ${analysis.callGrade}`);
    } catch (err) {
      console.error(`[TRANSCRIPTION/ANALYSIS] Error for call ${callId}:`, err.message);
    }
  }

  // Store everything to Supabase
  await recordCallEvent({
    callId,
    personId,
    userId,
    repName: rep?.name,
    leadName: lead?.name,
    duration,
    direction,
    outcome,
    createdAt,
    speedToLead,
    recordingUrl,
    transcript,
    leadScore: analysis?.leadScore ?? null,
    callGrade: analysis?.callGrade ?? null,
    callGradeColor: analysis?.callGradeColor ?? null,
    strengths: analysis?.strengths ?? [],
    improvements: analysis?.improvements ?? [],
    coachingNotes: analysis?.coachingNotes ?? null,
    actionItem: analysis?.actionItem ?? null,
    leadTag: analysis?.leadTag ?? null,
    leadAiSummary: analysis?.leadAiSummary ?? null
  });

  console.log(`[CALL] Stored call ${callId} successfully`);
}

// ---- PERSON CREATED (lead came in) ----
async function handlePersonEvent(data) {
  const { id: personId, created, source, assignedTo } = data;
  await recordLeadCreated({
    personId,
    source: source || 'facebook',
    assignedTo,
    createdAt: created || new Date().toISOString()
  });
}

// ---- APPOINTMENT CREATED ----
async function handleAppointmentCreated(data) {
  const { personId, userId, created } = data;
  const { error } = await supabase.from('lead_events').insert({
    person_id: personId,
    user_id: userId,
    event_type: 'appointment_set',
    occurred_at: created || new Date().toISOString()
  });
  if (error) console.error('[APPT] Supabase error:', error.message);
}

// ---- FUB API HELPERS ----
async function getFUBUser(userId) {
  if (!userId) return null;
  try {
    const resp = await fetch(`https://api.followupboss.com/v1/users/${userId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.FUB_API_KEY + ':').toString('base64')}`
      }
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

async function getFUBPerson(personId) {
  if (!personId) return null;
  try {
    const resp = await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.FUB_API_KEY + ':').toString('base64')}`
      }
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

async function calculateSpeedToLead(personId, callCreatedAt) {
  if (!personId || !callCreatedAt) return null;
  const { data } = await supabase
    .from('leads')
    .select('created_at, first_call_at')
    .eq('person_id', personId)
    .single();
  if (!data?.created_at) return null;
  const leadCreated = new Date(data.created_at).getTime();
  const firstCall = new Date(callCreatedAt).getTime();
  return Math.round((firstCall - leadCreated) / 1000 / 60 * 10) / 10; // minutes, 1 decimal
}
