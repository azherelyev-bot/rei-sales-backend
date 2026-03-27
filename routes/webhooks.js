const { supabase } = require('../db/supabase');
const { getPerson } = require('../db/followupboss');
const { transcribeCall } = require('../pipeline/transcribe');
const { analyzeCall } = require('../pipeline/analyze');
const { log } = require('../utils/logger');

/**
 * Triggered by FUB "callCompleted" webhook.
 * Full pipeline: fetch recording → transcribe → analyze → save → update lead score.
 */
async function handleCallCompleted(data) {
  const {
    id: fubCallId,
    personId,
    userId: fubUserId,     // the rep who made the call
    duration,              // in seconds
    recordingUrl,
    created: calledAt
  } = data;

  if (!recordingUrl) {
    log('warn', `Call ${fubCallId} has no recording URL — skipping analysis`);
    return;
  }

  if (!duration || duration < 30) {
    log('info', `Call ${fubCallId} too short (${duration}s) — skipping analysis`);
    return;
  }

  // 1. Look up rep in our DB
  const { data: rep, error: repErr } = await supabase
    .from('reps')
    .select('*')
    .eq('fub_user_id', String(fubUserId))
    .single();

  if (repErr || !rep) {
    log('warn', `Rep not found for FUB user ${fubUserId} — ensure reps are seeded in DB`);
    return;
  }

  // 2. Fetch lead info from FUB
  let leadName = 'Unknown Lead';
  let leadSource = 'unknown';
  try {
    const person = await getPerson(personId);
    leadName = `${person.firstName || ''} ${person.lastName || ''}`.trim() || 'Unknown Lead';
    leadSource = person.source?.toLowerCase() || 'unknown';
  } catch (e) {
    log('warn', `Could not fetch FUB person ${personId}: ${e.message}`);
  }

  // 3. Upsert call record immediately (so dashboard shows it even before analysis)
  const { data: callRecord, error: callErr } = await supabase
    .from('calls')
    .upsert({
      fub_call_id: String(fubCallId),
      rep_id: rep.id,
      lead_id: String(personId),
      lead_name: leadName,
      duration_seconds: duration,
      recording_url: recordingUrl,
      called_at: calledAt || new Date().toISOString()
    }, { onConflict: 'fub_call_id' })
    .select()
    .single();

  if (callErr) {
    log('error', `Failed to save call ${fubCallId}`, callErr);
    return;
  }

  // 4. Transcribe the call
  let transcript, durationSeconds;
  try {
    ({ transcript, durationSeconds } = await transcribeCall(recordingUrl, {
      repName: rep.name,
      leadName
    }));
  } catch (e) {
    log('error', `Transcription failed for call ${fubCallId}: ${e.message}`, e);
    return;
  }

  // 5. Analyze with Claude
  let analysis;
  try {
    analysis = await analyzeCall(transcript, {
      repName: rep.name,
      leadName,
      durationSeconds: durationSeconds || duration,
      leadSource
    });
  } catch (e) {
    log('error', `Analysis failed for call ${fubCallId}: ${e.message}`, e);
    // Save transcript even if analysis fails
    await supabase.from('calls').update({ transcript }).eq('id', callRecord.id);
    return;
  }

  // 6. Save everything to the call record
  const { error: updateErr } = await supabase
    .from('calls')
    .update({
      transcript,
      duration_seconds: durationSeconds || duration,
      ai_lead_score: analysis.lead_score,
      ai_call_grade: analysis.call_grade,
      ai_call_grade_numeric: analysis.call_grade_numeric,
      ai_strengths: analysis.strengths,
      ai_improvements: analysis.improvements,
      ai_coaching_notes: analysis.coaching_notes,
      ai_action_item: analysis.action_item,
      ai_summary: analysis.ai_summary,
      outcome: analysis.outcome
    })
    .eq('id', callRecord.id);

  if (updateErr) log('error', `Failed to update call analysis ${callRecord.id}`, updateErr);

  // 7. Update lead record with latest score + speed to lead
  const { data: leadRecord } = await supabase
    .from('leads')
    .select('*')
    .eq('fub_person_id', String(personId))
    .single();

  if (leadRecord) {
    const updates = { current_score: analysis.lead_score, status: analysis.outcome };

    // Compute speed to lead if this is the first call
    if (!leadRecord.first_call_at) {
      updates.first_call_at = calledAt || new Date().toISOString();
      if (leadRecord.lead_created_at) {
        const speedMs = new Date(updates.first_call_at) - new Date(leadRecord.lead_created_at);
        updates.speed_to_lead_seconds = Math.round(speedMs / 1000);
      }
    }

    await supabase.from('leads').update(updates).eq('id', leadRecord.id);
  }

  log('info',
    `Pipeline complete — ${rep.name} → ${leadName}: ` +
    `Score ${analysis.lead_score}/5, Grade ${analysis.call_grade}, Outcome: ${analysis.outcome}` +
    (analysis.benchmark_worthy ? ' ★ BENCHMARK' : '')
  );
}

/**
 * Triggered by FUB "personCreated" webhook.
 * Creates the lead record and starts the speed-to-lead clock.
 */
async function handleNewLead(data, type = 'new') {
  const {
    id: fubPersonId,
    firstName,
    lastName,
    phones,
    emails,
    source,
    created: leadCreatedAt,
    assignedTo   // FUB user ID of assigned rep
  } = data;

  const leadName = `${firstName || ''} ${lastName || ''}`.trim();
  const phone = phones?.[0]?.value;
  const email = emails?.[0]?.value;

  if (type === 'new') {
    // Find assigned rep
    let repId = null;
    if (assignedTo) {
      const { data: rep } = await supabase
        .from('reps')
        .select('id')
        .eq('fub_user_id', String(assignedTo))
        .single();
      repId = rep?.id || null;
    }

    const { error } = await supabase
      .from('leads')
      .upsert({
        fub_person_id: String(fubPersonId),
        assigned_rep_id: repId,
        name: leadName,
        phone,
        email,
        source: (source || 'unknown').toLowerCase(),
        lead_created_at: leadCreatedAt || new Date().toISOString(),
        status: 'new'
      }, { onConflict: 'fub_person_id' });

    if (error) log('error', `Failed to save new lead ${fubPersonId}`, error);
    else log('info', `New lead saved: ${leadName} from ${source}`);

  } else if (type === 'closed') {
    const closedAt = new Date().toISOString();
    const { data: lead } = await supabase
      .from('leads')
      .select('lead_created_at')
      .eq('fub_person_id', String(fubPersonId))
      .single();

    const updates = { status: 'closed', closed_at: closedAt };
    if (lead?.lead_created_at) {
      const ms = new Date(closedAt) - new Date(lead.lead_created_at);
      updates.close_time_hours = +(ms / 3600000).toFixed(2);
    }

    await supabase.from('leads').update(updates).eq('fub_person_id', String(fubPersonId));
    log('info', `Lead closed: ${leadName}`);
  }
}

module.exports = { handleCallCompleted, handleNewLead };
