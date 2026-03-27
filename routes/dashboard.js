const express = require('express');
const router = express.Router();
const { supabase } = require('../db/supabase');
const { log } = require('../utils/logger');

// ─── Helper ─────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function weekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1); // Monday
  return d.toISOString().split('T')[0];
}

// ─── GET /api/dashboard/overview ────────────────────────────────────────────
// Returns today's team-level metrics for the top bar
router.get('/dashboard/overview', async (req, res) => {
  try {
    const { data: stats, error } = await supabase
      .from('daily_stats')
      .select('*, reps(id, name)')
      .eq('date', today());

    if (error) throw error;

    const totalDials = stats.reduce((s, r) => s + r.total_dials, 0);
    const totalTalkSec = stats.reduce((s, r) => s + r.total_talk_seconds, 0);
    const speeds = stats.map(r => r.avg_speed_to_lead_seconds).filter(Boolean);
    const avgSpeed = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;

    const { count: leadsToday } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .gte('lead_created_at', `${today()}T00:00:00Z`);

    const { count: closesWeek } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'closed')
      .gte('closed_at', `${weekStart()}T00:00:00Z`);

    res.json({
      today: today(),
      team_dials_today: totalDials,
      avg_speed_to_lead_sec: avgSpeed,
      avg_speed_to_lead_min: avgSpeed ? +(avgSpeed / 60).toFixed(1) : null,
      total_talk_seconds: totalTalkSec,
      total_talk_formatted: formatSeconds(totalTalkSec),
      leads_today: leadsToday,
      closes_this_week: closesWeek
    });
  } catch (err) {
    log('error', 'Dashboard overview error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/reps ─────────────────────────────────────────────────
// Returns all reps with their today + week stats
router.get('/dashboard/reps', async (req, res) => {
  try {
    const { data: reps } = await supabase.from('reps').select('*');

    const repData = await Promise.all(reps.map(async rep => {
      // Today's stats
      const { data: todayStat } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('rep_id', rep.id)
        .eq('date', today())
        .single();

      // Week stats
      const { data: weekStats } = await supabase
        .from('daily_stats')
        .select('total_dials, closes, close_rate, avg_call_grade')
        .eq('rep_id', rep.id)
        .gte('date', weekStart());

      const weekDials = (weekStats || []).reduce((s, d) => s + d.total_dials, 0);
      const weekCloses = (weekStats || []).reduce((s, d) => s + d.closes, 0);
      const weekCloseRate = weekDials > 0 ? Math.round((weekCloses / weekDials) * 100) : 0;

      // Lead→close avg time
      const { data: closedLeads } = await supabase
        .from('leads')
        .select('close_time_hours')
        .eq('assigned_rep_id', rep.id)
        .not('close_time_hours', 'is', null);

      const avgCloseHours = closedLeads?.length > 0
        ? +(closedLeads.reduce((s, l) => s + l.close_time_hours, 0) / closedLeads.length).toFixed(1)
        : null;

      // Lead→close ratio (all time)
      const { count: totalLeads } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('assigned_rep_id', rep.id);

      const { count: totalCloses } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('assigned_rep_id', rep.id)
        .eq('status', 'closed');

      return {
        id: rep.id,
        name: rep.name,
        email: rep.email,
        today: {
          dials: todayStat?.total_dials || 0,
          talk_seconds: todayStat?.total_talk_seconds || 0,
          talk_formatted: formatSeconds(todayStat?.total_talk_seconds || 0),
          speed_to_lead_sec: todayStat?.avg_speed_to_lead_seconds,
          speed_to_lead_min: todayStat?.avg_speed_to_lead_seconds
            ? +(todayStat.avg_speed_to_lead_seconds / 60).toFixed(1) : null,
          idle_pct: todayStat?.idle_pct || 0,
          hourly_activity: todayStat?.hourly_activity || {},
          close_rate: todayStat?.close_rate || 0,
          avg_call_grade: todayStat?.avg_call_grade
        },
        week: {
          dials: weekDials,
          closes: weekCloses,
          close_rate: weekCloseRate
        },
        all_time: {
          total_leads: totalLeads || 0,
          total_closes: totalCloses || 0,
          lead_to_close_ratio: totalLeads > 0 ? `${totalCloses}/${totalLeads}` : '0/0',
          avg_close_days: avgCloseHours ? +(avgCloseHours / 24).toFixed(1) : null
        }
      };
    }));

    res.json(repData);
  } catch (err) {
    log('error', 'Dashboard reps error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/rep/:repId/calls ────────────────────────────────────
// Returns recent calls + coaching notes for a specific rep
router.get('/dashboard/rep/:repId/calls', async (req, res) => {
  try {
    const { repId } = req.params;
    const limit = parseInt(req.query.limit || '20');

    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('rep_id', repId)
      .order('called_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(calls);
  } catch (err) {
    log('error', 'Rep calls error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/rep/:repId/leads ────────────────────────────────────
// Returns lead queue for a rep with current scores
router.get('/dashboard/rep/:repId/leads', async (req, res) => {
  try {
    const { repId } = req.params;

    const { data: leads, error } = await supabase
      .from('leads')
      .select('*')
      .eq('assigned_rep_id', repId)
      .not('status', 'eq', 'closed')
      .order('current_score', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(leads);
  } catch (err) {
    log('error', 'Rep leads error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/awards ──────────────────────────────────────────────
// Returns current week's SOTW and COTW
router.get('/dashboard/awards', async (req, res) => {
  try {
    const { data: award, error } = await supabase
      .from('weekly_awards')
      .select('*, sotw_rep:reps!sotw_rep_id(name), cotw_call:calls!cotw_call_id(lead_name, ai_call_grade, duration_seconds, reps(name))')
      .gte('week_start', weekStart())
      .order('week_start', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    res.json(award || null);
  } catch (err) {
    log('error', 'Awards error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/dashboard/leaderboard ─────────────────────────────────────────
// Weekly leaderboard, sorted by composite score
router.get('/dashboard/leaderboard', async (req, res) => {
  try {
    const { data: stats } = await supabase
      .from('daily_stats')
      .select('rep_id, total_dials, closes, close_rate, avg_call_grade, idle_pct, reps(name)')
      .gte('date', weekStart());

    const repMap = {};
    (stats || []).forEach(row => {
      if (!repMap[row.rep_id]) {
        repMap[row.rep_id] = { rep_id: row.rep_id, name: row.reps?.name, days: [] };
      }
      repMap[row.rep_id].days.push(row);
    });

    const leaderboard = Object.values(repMap).map(r => {
      const d = r.days;
      const dials = d.reduce((s, x) => s + x.total_dials, 0);
      const closes = d.reduce((s, x) => s + x.closes, 0);
      const closeRate = dials > 0 ? Math.round((closes / dials) * 100) : 0;
      const avgGrade = d.filter(x => x.avg_call_grade).reduce((s, x, _, a) => s + x.avg_call_grade / a.length, 0);
      const avgIdle = d.reduce((s, x) => s + x.idle_pct, 0) / d.length;

      // Composite score: weighted formula
      const composite = +(
        (closeRate / 100) * 35 +
        (avgGrade / 5) * 30 +
        (dials / 100) * 20 +
        ((100 - avgIdle) / 100) * 15
      ).toFixed(2);

      return { rep_id: r.rep_id, name: r.name, dials, closes, close_rate: closeRate, avg_grade: +avgGrade.toFixed(2), idle_pct: +avgIdle.toFixed(1), composite_score: composite };
    }).sort((a, b) => b.composite_score - a.composite_score);

    res.json(leaderboard);
  } catch (err) {
    log('error', 'Leaderboard error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function formatSeconds(sec) {
  if (!sec || sec === 0) return '0h 0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

module.exports = router;
