'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const app     = express();

const weatherRoutes = require('./routes/weather');
const userRoutes    = require('./routes/users');
const { startScheduler, runMonitoringCycle } = require('./scheduler/monitorJob');
const {
  sendTestWeatherAlertEmail,
  isEmailConfigured,
  getEmailConfig,
} = require('./services/emailService');

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use('/api/weather', weatherRoutes);
app.use('/api/users',   userRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status:                   'ok',
    apiKeyConfigured:         Boolean(process.env.WEATHER_API_KEY?.trim()),
    emailConfigured:          isEmailConfigured(),
    emailSender:              process.env.BREVO_SENDER_EMAIL || null,
    emailRecipientConfigured: Boolean(process.env.ALERT_RECIPIENT_EMAIL?.trim()),
    time:                     new Date().toISOString(),
  });
});

// Manual monitoring cycle trigger (admin / demo)
app.post('/api/admin/trigger-monitor', (_req, res) => {
  console.log('\n[Admin] Manual monitoring cycle triggered.');
  res.json({ message: 'Monitoring cycle started. Watch the console for results.' });
  setImmediate(() => runMonitoringCycle().catch(err => console.error('[Admin] Monitor error:', err.message)));
});

/**
 * POST /api/alerts/test-email
 * POST /api/admin/test-email
 * Send a test weather alert email via Brevo.
 * Body: { email: "user@example.com", city?: "CityName" }
 */
async function handleTestEmail(req, res) {
  const { email, city, name } = req.body || {};
  let dashboardUrl = req.body?.dashboardUrl;
  if (!dashboardUrl) {
    const origin = req.get('origin') || req.get('referer');
    if (origin) {
      try {
        const parsed = new URL(origin);
        dashboardUrl = parsed.origin;
      } catch (_) {}
    }
  }
  const cfg = getEmailConfig();
  const to  = (email || cfg.defaultRecipient || cfg.senderEmail || '').trim();

  if (!isEmailConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'BREVO_API_KEY is not configured in .env.',
    });
  }
  if (!to || !to.includes('@')) {
    return res.status(400).json({
      success: false,
      error: 'A valid recipient email is required in the request body ({ email }) or ALERT_RECIPIENT_EMAIL in .env.',
    });
  }

  try {
    const result = await sendTestWeatherAlertEmail({ email: to, city, name, dashboardUrl });
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error || 'Brevo dispatch failed.' });
    }
    res.json({
      success:   true,
      messageId: result.messageId || 'SENT',
      recipient: to,
      message:   `Weather alert email dispatched via Brevo to ${to}!`,
    });
  } catch (err) {
    console.error('[Test Email] Exception:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

app.post('/api/alerts/test-email',  handleTestEmail);
app.post('/api/admin/test-email',   handleTestEmail);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  const emailStatus = isEmailConfigured() ? 'LIVE (BREVO)' : 'NOT CONFIGURED';
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  WeatherWatch — Email Alert System`);
  console.log(`  Server   : http://localhost:${PORT}`);
  console.log(`  Health   : http://localhost:${PORT}/api/health`);
  console.log(`  API Key  : ${process.env.WEATHER_API_KEY ? 'Loaded ✓' : 'NOT SET ✗'}`);
  console.log(`  Email API: ${emailStatus}`);
  console.log(`════════════════════════════════════════════════════\n`);

  startScheduler();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
    console.error(`👉 Either terminate the existing process or change PORT in your .env file.\n`);
    process.exit(1);
  } else {
    console.error(`\n❌ Server error:`, err.message);
    process.exit(1);
  }
});
