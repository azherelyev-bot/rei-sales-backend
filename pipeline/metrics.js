const { supabase } = require('../db/supabase');
const { getUsers, getActivityForUser, getRecentCalls } = require('../db/followupboss');
const { computeWeeklyAwards } = require('./analyze');
const { log } = require('../utils/logger');

const WORK_START = parseInt(process.env.WORK_START_HOUR || '8');
const WORK_END = parseInt(process.env.WORK_END_HOUR || '18');
const WORK_HOURS = WORK_END - WORK_START;
const ACTIVITY_WINDOW_MIN = 5; // gap in minutes = idle

/**
 * Computes idle percentage for a rep based on their activity events.
 * Logic: for each 5-min slot during working hours, mark as active if
 * there was any FUB event (call, note, email, task, stage change).
 */
function computeIdleMetrics(activityEvents, date = new Date()) {
  const slots = WORK_HOURS * 12; // 5-min slots in a workday
  const activeSlots = new Set();
  const hourlyActivity = {};

  // Init hourly buckets
  for (let h = WORK_START; h < WORK_END; h++) {
    hourlyActivity[h] = 0;
  }

  activityEvents.forEach(event => {
    const ts = new Date(event.created || event.updatedAt);
    const hour = ts.getHours();
    if (hour < WORK_START || hour >= WORK_END) return;

    const slotIndex = (hour - WORK_START) * 12 + Math.floor(ts.getMinutes() / 5);
    activeSlots.add(slotIndex);

    // Track activity per hour (count events)
    if (hourlyActivity[hour] !== undefined) {
      hourlyActivity[hour]++;
    }
  });

  const idlePct = Math.round(((slots - activeSlots.size) / slots) * 100);

  // Normalize hourly activity to 0–100 percentage
  const maxEvents = Math.max(...Object.values(hourlyActivity), 1);
  const hourlyPct = {};
  Object.entries(hourlyActivity).forEach(([hour, count]) => {
    hourlyPct[hour] = Math.min(100, Math.round((count / maxEvents) * 100));
  });

  return { idlePct, hourlyPct };
}

/**
 * Runs every 5 minutes. Pulls FUB activity for all reps and
 * upserts today's daily_stats row with current numbers.
 */
async function computeDailyMetrics() {
  const today = new Date().toISOString().split('T')[0];

  // Get all reps from Supabase
  const { data: reps, error: repsErr } = await supabase.from('reps').select('*');
  if (repsErr) { log('error', 'Failed to fetch reps', repsErr); return; }

  for (const rep of reps) {
    try {
      // Pull today's activity from FUB
      const since = `${today}T${String(WORK_START).padStart(2,'0')}:00:00Z`;
      const activity = await getActivityForUser(rep.fub_user_id, { since });

      const { idlePct, hourlyPct } = computeIdleMetrics(activity);

      // Pull today's calls from Supabase (already saved by webhook pipeline)
      const { data: todayCalls } = await supabase
        .from('calls')
        .select('duration_seconds, ai_call_grade_numeric, outcome')
        .eq('rep_id', rep.id)
        .gte('called_at', `${today}T00:00:00Z`);

      const totalDials = todayCalls?.length || 0;
      const totalTalkSeconds = (todayCalls || []).reduce((sum, c) => sum + (c.duration_seconds || 0), 0);
      const closes = (todayCalls || []).filter(c => c.outcome === 'closed' || c.outcome === 'appointment_set').length;
      const closeRate = totalDials > 0 ? Math.round((closes / totalDials) * 100) : 0;
      const grades = (todayCalls || []).map(c => c.ai_call_grade_numeric).filter(Boolean);
      const avgGrade = grades.length > 0 ? +(grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2) : null;

      // Pull speed to lead avg for today
      const { data: todayLeads } = await supabase
        .from('leads')
        .select('speed_to_lead_seconds')
        .eq('assigned_rep_id', rep.id)
        .gte('lead_created_at', `${today}T00:00:00Z`)
        .not('speed_to_lead_seconds', 'is', null);

      const speeds = (todayLeads || []).map(l => l.speed_to_lead_seconds).filter(Boolean);
      const avgSpeed = speeds.length > 0 ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;

      // Upsert daily_stats
      const { error: upsertErr } = await supabase
        .from('daily_stats')
        .upsert({
          rep_id: rep.id,
          date: today,
          total_dials: totalDials,
          total_talk_seconds: totalTalkSeconds,
          avg_speed_to_lead_seconds: avgSpeed,
          idle_pct: idlePct,
          hourly_activity: hourlyPct,
          leads_contacted: totalDials,
          closes,
          close_rate: closeRate,
          avg_call_grade: avgGrade
        }, { onConflict: 'rep_id,date' });

      if (upsertErr) log('error', `Failed to upsert daily stats for ${rep.name}`, upsertErr);
      else log('info', `Updated daily stats for ${rep.name}: ${totalDials} dials, ${idlePct}% idle`);

    } catch (err) {
      log('error', `Metrics error for rep ${rep.name}: ${err.message}`, err);
    }
  }
}

/**
 * Nightly job: computes weekly awards after daily stats are finalized.
 */
async function rollupDaily() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday

  // Only compute awards on Sunday
  if (dayOfWeek === 0) {
    await computeWeeklyAwardsJob();
  }

  log('info', 'Nightly rollup complete');
}

async function computeWeeklyAwardsJob() {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  // Get weekly stats per rep
  const { data: stats } = await supabase
    .from('daily_stats')
    .select('*, reps(name)')
    .gte('date', weekStartStr)
    .lte('date', todayStr);

  // Group by rep
  const repMap = {};
  (stats || []).forEach(row => {
    if (!repMap[row.rep_id]) repMap[row.rep_id] = { rep_id: row.rep_id, rep_name: row.reps?.name, days: [] };
    repMap[row.rep_id].days.push(row);
  });

  const repStats = Object.values(repMap).map(r => ({
    rep_id: r.rep_id,
    rep_name: r.rep_name,
    total_dials: r.days.reduce((s, d) => s + d.total_dials, 0),
    avg_close_rate: +(r.days.reduce((s, d) => s + (d.close_rate || 0), 0) / r.days.length).toFixed(1),
    avg_speed_to_lead_sec: Math.round(r.days.reduce((s, d) => s + (d.avg_speed_to_lead_seconds || 0), 0) / r.days.length),
    avg_idle_pct: +(r.days.reduce((s, d) => s + d.idle_pct, 0) / r.days.length).toFixed(1),
    avg_call_grade: +(r.days.reduce((s, d) => s + (d.avg_call_grade || 0), 0) / r.days.filter(d => d.avg_call_grade).length).toFixed(2)
  }));

  // Get this week's calls
  const { data: weekCalls } = await supabase
    .from('calls')
    .select('*, reps(name)')
    .gte('called_at', `${weekStartStr}T00:00:00Z`)
    .order('ai_call_grade_numeric', { ascending: false });

  const callsForClaude = (weekCalls || []).map(c => ({
    ...c,
    rep_name: c.reps?.name
  }));

  try {
    const awards = await computeWeeklyAwards(repStats, callsForClaude);

    await supabase.from('weekly_awards').upsert({
      week_start: weekStartStr,
      sotw_rep_id: awards.sotw_rep_id,
      cotw_call_id: awards.cotw_call_id,
      sotw_reason: `${awards.sotw_reason} ${awards.sotw_key_stats}`,
      cotw_reason: awards.cotw_reason
    }, { onConflict: 'week_start' });

    log('info', `Weekly awards set: SOTW=${awards.sotw_rep_name}, COTW=${awards.cotw_rep_name} lead ${awards.cotw_lead_name}`);
  } catch (err) {
    log('error', `Weekly awards failed: ${err.message}`, err);
  }
}

module.exports = { computeDailyMetrics, rollupDaily };
