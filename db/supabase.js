const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = { supabase };

// ─── SUPABASE SCHEMA ──────────────────────────────────────────────────────────
// Run this SQL in your Supabase SQL editor to set up all tables:
//
// -- Reps
// CREATE TABLE reps (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   fub_user_id TEXT UNIQUE NOT NULL,
//   name TEXT NOT NULL,
//   email TEXT,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Calls (one row per completed call)
// CREATE TABLE calls (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   fub_call_id TEXT UNIQUE NOT NULL,
//   rep_id UUID REFERENCES reps(id),
//   lead_id TEXT NOT NULL,             -- FUB person ID
//   lead_name TEXT,
//   lead_phone TEXT,
//   duration_seconds INT,
//   recording_url TEXT,
//   transcript TEXT,
//   ai_lead_score INT CHECK (ai_lead_score BETWEEN 1 AND 5),
//   ai_call_grade TEXT,                -- A+, B, C, D, F
//   ai_call_grade_numeric FLOAT,       -- 4.2, 3.1, etc
//   ai_strengths JSONB,                -- ["Rapport Building", ...]
//   ai_improvements JSONB,
//   ai_coaching_notes TEXT,
//   ai_action_item TEXT,
//   ai_summary TEXT,
//   outcome TEXT,                      -- appointment_set, callback, lost, nurture
//   called_at TIMESTAMPTZ NOT NULL,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Leads (one row per inbound lead)
// CREATE TABLE leads (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   fub_person_id TEXT UNIQUE NOT NULL,
//   assigned_rep_id UUID REFERENCES reps(id),
//   name TEXT,
//   phone TEXT,
//   email TEXT,
//   source TEXT,                       -- facebook, calendly, direct
//   lead_created_at TIMESTAMPTZ,
//   first_call_at TIMESTAMPTZ,
//   speed_to_lead_seconds INT,         -- computed: first_call_at - lead_created_at
//   closed_at TIMESTAMPTZ,
//   close_time_hours FLOAT,            -- computed: closed_at - lead_created_at
//   status TEXT DEFAULT 'new',         -- new, contacted, nurture, appointment, closed, lost
//   current_score INT,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Daily rep stats (rolled up every 5 min, finalized nightly)
// CREATE TABLE daily_stats (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   rep_id UUID REFERENCES reps(id),
//   date DATE NOT NULL,
//   total_dials INT DEFAULT 0,
//   total_talk_seconds INT DEFAULT 0,
//   avg_speed_to_lead_seconds FLOAT,
//   idle_pct FLOAT,                    -- 0–100
//   hourly_activity JSONB,             -- { "8": 80, "9": 55, ... } pct active per hour
//   leads_contacted INT DEFAULT 0,
//   closes INT DEFAULT 0,
//   close_rate FLOAT,
//   avg_call_grade FLOAT,
//   UNIQUE(rep_id, date)
// );
//
// -- Weekly awards (computed every Sunday night)
// CREATE TABLE weekly_awards (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   week_start DATE NOT NULL,
//   sotw_rep_id UUID REFERENCES reps(id),   -- salesperson of the week
//   cotw_call_id UUID REFERENCES calls(id), -- call of the week
//   sotw_reason TEXT,
//   cotw_reason TEXT,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Indexes for dashboard queries
// CREATE INDEX idx_calls_rep_id ON calls(rep_id);
// CREATE INDEX idx_calls_called_at ON calls(called_at);
// CREATE INDEX idx_daily_stats_rep_date ON daily_stats(rep_id, date);
// CREATE INDEX idx_leads_rep ON leads(assigned_rep_id);
