'use strict';

// Note: dotenv is loaded by server.js at startup — no need to re-load here.
const cron = require('node-cron');
const db   = require('../database/db');
const { fetchRawForecastByCity } = require('../services/weatherService');
const { detectRisks }         = require('../services/riskDetection');
const {
  sendWeatherAlertEmail,
  isEmailConfigured,
  getEmailConfig,
} = require('../services/emailService');

const getCooldownMs = () => (parseInt(process.env.ALERT_COOLDOWN_MINUTES, 10) || 180) * 60_000;

// ---------------------------------------------------------------------------
// Prepared statements (compiled once at startup)
// ---------------------------------------------------------------------------
const stmts = {
  uniqueCities: db.prepare(`SELECT DISTINCT city, city_normalized FROM users`),
  usersByCity:  db.prepare(`
    SELECT id, name, email, alert_rain, alert_heat, alert_wind, alert_thunder, snooze_until
    FROM users WHERE city_normalized = ?
  `),
  recentAlert:  db.prepare(`
    SELECT alerted_at FROM alert_history
    WHERE user_id = ? AND risk_type = ? AND city_normalized = ?
    ORDER BY alerted_at DESC LIMIT 1
  `),
  insertAlert:  db.prepare(`
    INSERT INTO alert_history (user_id, risk_type, city_normalized, severity, forecast_time)
    VALUES (?, ?, ?, ?, ?)
  `),
};

// Preference column mapping
const PREF_COL = {
  rain:             'alert_rain',
  heavy_rain:       'alert_rain',
  heat:             'alert_heat',
  high_temperature: 'alert_heat',
  wind:             'alert_wind',
  strong_wind:      'alert_wind',
  thunder:          'alert_thunder',
  thunderstorm:     'alert_thunder',
};

// ---------------------------------------------------------------------------
// Core monitoring cycle
// ---------------------------------------------------------------------------
async function runMonitoringCycle() {
  console.log(`\n[Monitor] ═══ Cycle started at ${new Date().toISOString()} ═══`);

  const cities = stmts.uniqueCities.all();
  if (cities.length === 0) {
    console.log('[Monitor] No registered users — nothing to check.');
    console.log(`[Monitor] ═══ Cycle finished ═══\n`);
    return;
  }

  console.log(`[Monitor] Checking ${cities.length} unique city/cities.`);
  for (const { city, city_normalized } of cities) {
    try {
      await processCity(city, city_normalized);
    } catch (err) {
      console.error(`[Monitor] ✗ Error for "${city}":`, err.message);
    }
  }
  console.log(`[Monitor] ═══ Cycle complete at ${new Date().toISOString()} ═══\n`);
}

async function processCity(city, city_normalized) {
  console.log(`[Monitor] Fetching forecast: ${city}`);
  const forecastData = await fetchRawForecastByCity(city);
  const risks        = detectRisks(forecastData);

  if (risks.length === 0) {
    console.log(`[Monitor] ${city}: normal conditions.`);
    return;
  }

  console.log(`[Monitor] ${city}: ⚠️ ${risks.length} risk(s) → [${risks.map(r => r.type).join(', ')}]`);

  // Extract weather snapshot for email context
  const first = forecastData?.list?.[0];
  const weatherData = first ? {
    temp:      first.main?.temp,
    condition: first.weather?.[0]?.main,
    humidity:  first.main?.humidity,
    windSpeed: first.wind ? Math.round(first.wind.speed * 3.6) : undefined,
  } : {};

  // System-level admin alert (env-configured recipient)
  const emailConfig = getEmailConfig();
  if (isEmailConfigured() && emailConfig.defaultRecipient) {
    try {
      await sendWeatherAlertEmail({
        recipientEmail: emailConfig.defaultRecipient,
        recipientName: 'Admin',
        city, risks, weatherData,
      });
    } catch (err) {
      console.error(`[Monitor] ✗ Admin email error for ${city}:`, err.message);
    }
  }

  // Per-user alerts
  const cooldownMs = getCooldownMs();
  const users = stmts.usersByCity.all(city_normalized);
  console.log(`[Monitor] ${city}: ${users.length} registered user(s).`);

  for (const user of users) {
    await processUser(user, city, city_normalized, risks, cooldownMs, weatherData);
  }
}

async function processUser(user, city, city_normalized, risks, cooldownMs, weatherData) {
  // Snooze guard — skip if user manually silenced alerts for this window
  if (user.snooze_until && new Date(user.snooze_until) > new Date()) {
    const until = new Date(user.snooze_until).toLocaleString();
    console.log(`[Monitor] ${user.email}: alerts snoozed until ${until} — skipping.`);
    return;
  }

  // Filter risks matching user preferences
  const relevant = risks.filter(risk => {
    const col = PREF_COL[risk.type] || PREF_COL[(risk.type || '').toLowerCase()];
    return col && user[col] === 1;
  });
  if (relevant.length === 0) {
    console.log(`[Monitor] ${user.email}: no matching risk preferences for ${city}.`);
    return;
  }

  // Filter out risks on cooldown (per-user DB history check)
  const toSend = relevant.filter(risk => {
    const row = stmts.recentAlert.get(user.id, risk.type, city_normalized);
    if (!row) return true;
    const elapsed = Date.now() - new Date(row.alerted_at).getTime();
    if (elapsed < cooldownMs) {
      const rem = Math.round((cooldownMs - elapsed) / 60_000);
      console.log(`[Monitor] ${user.email} — "${risk.type}" cooldown active (${rem}m).`);
      return false;
    }
    return true;
  });
  if (toSend.length === 0) return;

  // Dispatch email via Brevo
  if (!user.email || !isEmailConfigured()) {
    console.warn(`[Monitor] Skipping ${user.name}: no email or Brevo not configured.`);
    return;
  }

  console.log(`[Monitor] Sending alert email → ${user.email} via Brevo...`);
  try {
    const result = await sendWeatherAlertEmail({
      recipientEmail: user.email,
      recipientName:  user.name,
      city, risks: toSend, weatherData,
    });

    if (result.success && !result.skipped) {
      // Record in history to enforce cooldown
      db.exec('BEGIN');
      try {
        for (const risk of toSend) {
          stmts.insertAlert.run(user.id, risk.type, city_normalized, risk.severity, risk.forecastTime || null);
        }
        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        console.error(`[Monitor] Failed to record alert history:`, txErr.message);
      }
      console.log(`[Monitor] ✓ Email delivered to ${user.email} [${result.messageId || 'SENT'}]`);
    } else if (result.skipped) {
      console.log(`[Monitor] Email skipped for ${user.email}: ${result.reason}`);
    } else {
      console.error(`[Monitor] ✗ Email failed for ${user.email}:`, result.error);
    }
  } catch (err) {
    console.error(`[Monitor] ✗ Email exception for ${user.email}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
function startScheduler() {
  const interval = Math.max(1, parseInt(process.env.WEATHER_CHECK_INTERVAL, 10) || 30);
  const cronExpr = interval === 1 ? '* * * * *' : `*/${interval} * * * *`;

  if (!cron.validate(cronExpr)) {
    console.error(`[Scheduler] Invalid cron "${cronExpr}", defaulting to */30.`);
    cron.schedule('*/30 * * * *', () => runMonitoringCycle().catch(console.error));
    return;
  }

  console.log(`[Scheduler] Monitoring every ${interval} minute(s) [${cronExpr}].`);
  cron.schedule(cronExpr, () => runMonitoringCycle().catch(console.error));
}

module.exports = { startScheduler, runMonitoringCycle };
