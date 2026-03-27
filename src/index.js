import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { webhookRouter } from './webhooks/followupboss.js';
import { dashboardRouter } from './routes/dashboard.js';
import { syncRouter } from './routes/sync.js';
import { syncDailyMetrics } from './services/metricsAggregator.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/webhook', webhookRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/sync', syncRouter);
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Sync metrics every 5 minutes during working hours Mon-Fri
cron.schedule('*/5 8-18 * * 1-5', async () => {
  console.log('[CRON] Syncing daily metrics...');
  await syncDailyMetrics();
});

// Full recalc at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Daily reset...');
  await syncDailyMetrics('yesterday');
});

app.listen(PORT, () => {
  console.log('\nREI Lead Pros — Sales Command Center');
  console.log('Server on port', PORT);
});
