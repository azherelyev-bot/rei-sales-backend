const Anthropic = require('@anthropic-ai/sdk');
const { log } = require('../utils/logger');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analyzes a call transcript using Claude.
 * Returns structured JSON with lead score, coaching notes, grade, and action items.
 *
 * @param {string} transcript - Full call transcript from Whisper
 * @param {object} context
 * @param {string} context.repName - Sales rep name
 * @param {string} context.leadName - Lead name
 * @param {number} context.durationSeconds - Call duration
 * @param {string} context.leadSource - facebook, calendly, direct
 * @returns {Promise<AnalysisResult>}
 */
async function analyzeCall(transcript, context = {}) {
  const { repName = 'Rep', leadName = 'Lead', durationSeconds = 0, leadSource = 'unknown' } = context;
  const durationMin = Math.round(durationSeconds / 60);

  log('info', `Analyzing call: ${repName} → ${leadName} (${durationMin} min)`);

  const systemPrompt = `You are the AI Sales Coach for REI Lead Pros, a real estate wholesaling and lead generation company targeting motivated sellers in the South Metro Atlanta market.

Your job is to analyze recorded sales call transcripts between REI Lead Pros reps and homeowner leads. You evaluate call quality, lead motivation, and rep performance with the precision of a seasoned real estate sales trainer.

You ALWAYS respond with valid JSON only. No prose, no markdown, no code fences. Just a raw JSON object.

COMPANY CONTEXT:
- Leads come from Facebook ads → landing page form → either Calendly book or direct call by rep
- Goal of every call: qualify the lead, identify motivation/urgency, and secure an appointment (never give price over the phone)
- Speed to lead target: under 5 minutes from form fill to first call
- Rep SOP: max 2 calls + 1 text before CEO escalation
- Disqualification triggers: no urgency, no equity, unwilling to meet, attorney/agent already engaged

SCORING RUBRICS:

Lead Score (1–5):
5 = Underwater/pre-foreclosure, immediate timeline (0–30 days), high equity, motivated to sell, agreed to appointment
4 = Clear problem (divorce, inheritance, relocation), 30–60 day timeline, confirmed equity, ready to talk numbers
3 = Motivated but 60–90 day timeline, equity likely, needs nurturing
2 = Some situation but no urgency, long timeline, uncertain equity
1 = No motivation, no equity, wasting rep time — should have been disqualified early

Call Grade:
A+ = Textbook execution: strong open, pain discovery, objection handling, appointment close. Benchmark material.
A  = Excellent call, minor polish needed
B+ = Good call, one clear missed opportunity
B  = Competent, two areas need work
C+ = Average, inconsistent technique, prospect disengaged at points
C  = Below average, several issues, close was not attempted or failed badly
D  = Poor — lost control, bad tonality, or massive missed opportunity on hot lead
F  = Failed entirely — no discovery, flat tone, lead hung up or was driven away

Strengths to evaluate:
Rapport Building, Pain Discovery, Urgency Creation, Objection Handling, Call Control, Tonality, Qualifying Questions, Appointment Close, Price Anchoring, Disqualification Speed, Follow-up Setup, Active Listening

Outcomes:
appointment_set, callback_scheduled, nurture, lost_disqualified, lost_competitor, lost_no_show, closed`;

  const userPrompt = `Analyze this real estate sales call and return a JSON object.

REP: ${repName}
LEAD: ${leadName}
SOURCE: ${leadSource}
DURATION: ${durationMin} minutes (${durationSeconds} seconds)

TRANSCRIPT:
${transcript}

Return ONLY this JSON structure (no other text):
{
  "lead_score": <1-5 integer>,
  "lead_score_reason": "<1 sentence explaining the score>",
  "call_grade": "<A+|A|B+|B|C+|C|D|F>",
  "call_grade_numeric": <4.2 = A+, 4.0 = A, 3.7 = B+, 3.3 = B, 2.7 = C+, 2.3 = C, 1.7 = D, 1.0 = F>,
  "outcome": "<appointment_set|callback_scheduled|nurture|lost_disqualified|lost_competitor|lost_no_show|closed>",
  "ai_summary": "<2-3 sentence plain English summary of what happened on this call>",
  "coaching_notes": "<3-5 sentence detailed coaching feedback for the rep. Be direct, specific, and reference exact moments in the call>",
  "strengths": ["<strength1>", "<strength2>", "<up to 4 strengths>"],
  "improvements": ["<area1>", "<area2>", "<up to 4 areas to improve>"],
  "action_item": "<Single, specific, immediately actionable thing this rep must do differently starting on their next call. One sentence, direct language.>",
  "lead_situation": "<divorce|pre_foreclosure|inheritance|relocation|financial_hardship|downsizing|tired_landlord|other>",
  "lead_urgency": "<immediate|30_days|60_days|90_days|unknown|no_urgency>",
  "equity_confirmed": <true|false|null>,
  "appointment_set": <true|false>,
  "price_given_on_call": <true|false>,
  "disqualified_correctly": <true|false|null>,
  "rep_talk_ratio": <estimated percentage of time rep was talking, 0-100>,
  "missed_close_opportunity": <true|false>,
  "benchmark_worthy": <true|false — only true for A+ calls that should be used for training>
}`;

  const response = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  const rawText = response.content[0].text.trim();

  // Strip any accidental markdown fences
  const jsonText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  let analysis;
  try {
    analysis = JSON.parse(jsonText);
  } catch (e) {
    log('error', `Failed to parse Claude response as JSON: ${rawText}`);
    throw new Error(`Claude analysis returned invalid JSON: ${e.message}`);
  }

  log('info', `Analysis complete: Score ${analysis.lead_score}/5, Grade ${analysis.call_grade}`);

  return analysis;
}

/**
 * Computes the weekly awards — SOTW and COTW.
 * Called every Sunday night after all daily stats are rolled up.
 *
 * @param {Array} repStats - Array of weekly stat objects per rep
 * @param {Array} calls - Array of all calls this week
 * @returns {Promise<{sotw: object, cotw: object}>}
 */
async function computeWeeklyAwards(repStats, calls) {
  log('info', 'Computing weekly awards with Claude');

  const statsJson = JSON.stringify(repStats, null, 2);
  const callsJson = JSON.stringify(
    calls.map(c => ({
      id: c.id,
      rep: c.rep_name,
      lead: c.lead_name,
      grade: c.ai_call_grade,
      score: c.ai_lead_score,
      outcome: c.outcome,
      duration_min: Math.round(c.duration_seconds / 60),
      coaching_notes: c.ai_coaching_notes
    })),
    null, 2
  );

  const response = await claude.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are the REI Lead Pros Sales AI. Based on this week's data, determine:
1. Salesperson of the Week (SOTW) — consider close rate, dials, speed to lead, call quality scores
2. Call of the Week (COTW) — the single best call this week based on technique, outcome, and coaching value

REP WEEKLY STATS:
${statsJson}

CALLS THIS WEEK:
${callsJson}

Return ONLY this JSON:
{
  "sotw_rep_id": "<rep_id>",
  "sotw_rep_name": "<name>",
  "sotw_reason": "<2 sentences explaining why they won this week>",
  "sotw_key_stats": "<e.g. 22% close rate, 3.2 min speed to lead, 4.2 avg call score>",
  "cotw_call_id": "<call_id>",
  "cotw_rep_name": "<name>",
  "cotw_lead_name": "<lead name>",
  "cotw_reason": "<2 sentences explaining what made this the call of the week>",
  "cotw_benchmark_worthy": <true|false>
}`
    }]
  });

  const text = response.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(text);
}

module.exports = { analyzeCall, computeWeeklyAwards };
