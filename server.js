require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { handleCallCompleted, handleNewLead } = require('./routes/webhooks');
const { computeDailyMetrics } = require('./pipeline/metrics');
const { log } = require('./utils/logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const fubHeaders = {
  'Content-Type': 'application/json',
  'X-System': 'REI-Sales-AI',
  'X-System-Key': 'a5c50b177fcb97980fb3201d65b46824'
};

const fubAuth = {
  username: process.env.FUB_API_KEY,
  password: ''
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// FUB Webhooks receiver
app.post('/webhooks/fub', async (req, res) => {
  res.sendStatus(200);
  const { event, data } = req.body;
  log('info', `FUB webhook received: ${event}`);
  try {
    switch (event) {
      case 'callCompleted':
        await handleCallCompleted(data);
        break;
      case 'personCreated':
        await handleNewLead(data);
        break;
      case 'personUpdated':
        if (data.stage === 'Closed' || data.stage === 'Won') {
          await handleNewLead(data, 'closed');
        }
        break;
    }
  } catch (err) {
    log('error', `Webhook handler error: ${err.message}`, err);
  }
});

// Dashboard API
const dashboardRouter = require('./routes/dashboard');
app.use('/api', dashboardRouter);

// Scheduled jobs
cron.schedule('*/5 * * * *', async () => {
  log('info', 'Running 5-min metrics refresh');
  await computeDailyMetrics();
});

cron.schedule('0 0 * * *', async () => {
  log('info', 'Running nightly daily rollup');
  const { rollupDaily } = require('./pipeline/metrics');
  await rollupDaily();
});

// Register webhook with FUB
app.get('/setup/register-webhook', async (req, res) => {
  try {
    const webhookUrl = 'https://rei-sales-backend-production.up.railway.app/webhooks/fub';
    const events = ['callCompleted', 'personCreated', 'personUpdated'];
    const results = [];

    for (const event of events) {
      try {
        const r = await axios.post(
          'https://api.followupboss.com/v1/webhooks',
          { event, url: webhookUrl },
          { auth: fubAuth, headers: fubHeaders }
        );
        results.push({ event, status: 'registered', id: r.data.id });
      } catch (e) {
        results.push({ event, status: 'failed', error: e.response?.data || e.message });
      }
    }
    res.json({ webhookUrl, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test FUB connection
app.get('/setup/test-fub', async (req, res) => {
  try {
    const r = await axios.get('https://api.followupboss.com/v1/users', {
      auth: fubAuth,
      headers: fubHeaders
    });
    res.json({ success: true, users: r.data.users?.map(u => u.name) });
  } catch (e) {
    res.status(500).json({ error: e.response?.status, detail: e.response?.data });
  }
});

// Seed reps
app.get('/setup/seed-reps', async (req, res) => {
  try {
    const { getUsers } = require('./db/followupboss');
    const { supabase } = require('./db/supabase');
    const users = await getUsers();
    const reps = users.filter(u => u.isActive);
    for (const user of reps) {
      await supabase.from('reps').upsert({
        fub_user_id: String(user.id),
        name: user.name,
        email: user.email
      }, { onConflict: 'fub_user_id' });
    }
    res.json({ success: true, seeded: reps.map(r => r.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  log('info', `REI Sales Backend running on port ${PORT}`);
});
