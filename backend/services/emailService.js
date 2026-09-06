'use strict';

// Note: dotenv is loaded by server.js at startup — process.env is already populated.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * In-memory cooldown tracker for email alerts.
 * Key: `${recipient.toLowerCase()}|${cityNormalized}|${riskType.toLowerCase()}`
 * Value: timestamp (number)
 */
const alertCooldownCache = new Map();

/**
 * Retrieve configuration from environment variables.
 * Note: Never log or print the API key.
 */
function getEmailConfig() {
  return {
    apiKey: (process.env.BREVO_API_KEY || '').trim(),
    senderEmail: (process.env.BREVO_SENDER_EMAIL || 'rohithmm279@gmail.com').trim(),
    senderName: (process.env.BREVO_SENDER_NAME || "Rohith's Weather Watch").trim(),
    defaultRecipient: (process.env.ALERT_RECIPIENT_EMAIL || '').trim(),
    cooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES, 10) || 180,
    dashboardUrl: (process.env.DASHBOARD_URL || process.env.RENDER_EXTERNAL_URL || 'https://rohiths-weather-watch.onrender.com').trim(),
  };
}

/**
 * Check if the Brevo API key is configured.
 * @returns {boolean}
 */
function isEmailConfigured() {
  return Boolean(getEmailConfig().apiKey);
}

/**
 * Generate a cooldown cache key.
 */
function buildCooldownKey(recipient, city, riskType) {
  const normEmail = (recipient || '').trim().toLowerCase();
  const normCity  = (city || '').trim().toLowerCase();
  const normType  = (riskType || 'general').trim().toLowerCase();
  return `${normEmail}|${normCity}|${normType}`;
}

/**
 * Check if an alert for this recipient, city, and risk type is on cooldown.
 * @returns {{ active: boolean, remainingMinutes: number }}
 */
function checkCooldown(recipient, city, riskType) {
  const config = getEmailConfig();
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const key = buildCooldownKey(recipient, city, riskType);
  const lastSent = alertCooldownCache.get(key);

  if (!lastSent) {
    return { active: false, remainingMinutes: 0 };
  }

  const elapsed = Date.now() - lastSent;
  if (elapsed < cooldownMs) {
    const remainingMinutes = Math.ceil((cooldownMs - elapsed) / (60 * 1000));
    return { active: true, remainingMinutes };
  }

  // Cooldown expired, clear the stale entry
  alertCooldownCache.delete(key);
  return { active: false, remainingMinutes: 0 };
}

/**
 * Record that an alert has been successfully sent for cooldown enforcement.
 */
function recordAlertSent(recipient, city, riskType) {
  const key = buildCooldownKey(recipient, city, riskType);
  alertCooldownCache.set(key, Date.now());

  // Housekeeping: prevent memory leak by clearing entries older than 24 hours
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, ts] of alertCooldownCache.entries()) {
    if (ts < oneDayAgo) alertCooldownCache.delete(k);
  }
}

/**
 * Clear cooldown cache (useful for testing).
 */
function clearCooldownCache() {
  alertCooldownCache.clear();
}

/**
 * Generate sensible default impact descriptions for risk types.
 */
function getDefaultImpact(riskType = '') {
  const t = (riskType || '').toLowerCase();
  if (t.includes('rain')) {
    return 'High rainfall intensity expected. Potential localized flooding and reduced road visibility.';
  }
  if (t.includes('thunder')) {
    return 'Severe thunderstorm & lightning activity. Potential power interruptions and localized flash pooling.';
  }
  if (t.includes('heat')) {
    return 'Elevated thermal levels. Risk of heat exhaustion and severe dehydration during peak hours.';
  }
  if (t.includes('wind')) {
    return 'Strong wind gusts predicted. Potential loose debris movement and hazardous road travel.';
  }
  return 'Hazardous weather conditions detected. Stay informed and observe safety precautions.';
}

/**
 * Return condition emoji for the metrics grid.
 */
function getConditionEmoji(condition = '') {
  const c = (condition || '').toLowerCase();
  if (c.includes('thunder')) return '⚡';
  if (c.includes('rain') || c.includes('drizzle')) return '🌧️';
  if (c.includes('snow')) return '❄️';
  if (c.includes('clear') || c.includes('sun')) return '☀️';
  if (c.includes('cloud')) return '☁️';
  if (c.includes('wind')) return '💨';
  if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return '🌫️';
  if (c.includes('heat') || c.includes('hot')) return '🔥';
  return '⚠️';
}

/**
 * Format timestamp in human-readable style (e.g. Sunday, September 6, 2026 at 11:00 AM).
 */
function formatAlertDate(dateInput) {
  if (typeof dateInput === 'string' && dateInput.includes(',')) {
    return dateInput;
  }
  const d = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(d.getTime())) return String(dateInput || new Date().toLocaleString());

  return d.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Generate safety response actions based on risk types.
 */
function getSafetyAdvice(risks = []) {
  const types = risks.map(r => (r.type || '').toLowerCase());
  const adviceList = [];

  if (types.some(t => t.includes('rain'))) {
    adviceList.push({ label: 'Road Conditions', text: 'Drive with caution and avoid low-lying roadways prone to water logging.' });
    adviceList.push({ label: 'Drainage', text: 'Confirm storm drainage infrastructure near monitored points is clear of debris.' });
  }
  if (types.some(t => t.includes('thunder'))) {
    adviceList.push({ label: 'Shelter', text: 'Remain indoors away from windows and disconnect sensitive electronics during lightning activity.' });
    adviceList.push({ label: 'Exposed Areas', text: 'Avoid open grounds, bodies of water, and tall structures.' });
  }
  if (types.some(t => t.includes('heat'))) {
    adviceList.push({ label: 'Hydration', text: 'Maintain high fluid intake and minimize strenuous outdoor exposure during peak sun hours.' });
    adviceList.push({ label: 'Vulnerable Care', text: 'Ensure proper ventilation and check in on elderly relatives and pets.' });
  }
  if (types.some(t => t.includes('wind'))) {
    adviceList.push({ label: 'Structural Safety', text: 'Secure loose exterior structures, outdoor furniture, and overhead fixtures.' });
    adviceList.push({ label: 'Transit Caution', text: 'Be vigilant for falling branches and hazardous high-speed driving conditions.' });
  }

  // Consistent monitoring action
  adviceList.push({ label: 'Monitoring', text: 'Review real-time telemetry updates via your admin console.' });

  return adviceList;
}

/**
 * Build a responsive, clean, professional HTML weather alert email matching the Rohith's Weather Watch design.
 */
function buildAlertEmailHtml({
  alertTitle,
  city = 'Nepal',
  risks = [],
  weatherData = {},
  timestamp,
  recipientName = 'User',
  dashboardUrl,
}) {
  const safetyTips = getSafetyAdvice(risks);
  const formattedTime = formatAlertDate(timestamp);

  // Weather metrics
  const rawCondition = weatherData.condition || weatherData.desc || (risks[0]?.type ? `${risks[0].type.charAt(0).toUpperCase() + risks[0].type.slice(1)}` : 'Rain');
  const conditionEmoji = getConditionEmoji(rawCondition);

  const tempDisplay = weatherData.temp !== undefined
    ? `${Math.round(weatherData.temp)}°C`
    : (weatherData.currentTemp ? `${Math.round(weatherData.currentTemp)}°C` : '25°C');

  const windDisplay = weatherData.windSpeed !== undefined
    ? `${Math.round(weatherData.windSpeed)} km/h`
    : '4 km/h';

  const humidityDisplay = weatherData.humidity !== undefined
    ? `${Math.round(weatherData.humidity)}%`
    : '80%';

  const targetDashboardUrl = (
    dashboardUrl
    || process.env.DASHBOARD_URL
    || process.env.RENDER_EXTERNAL_URL
    || 'https://rohiths-weather-watch.onrender.com'
  ).trim();

  // Priority indicator
  const isSevere = risks.length === 0 || risks.some(r => (r.severity || '').toLowerCase() === 'severe');
  const priorityBadgeBg = isSevere ? '#ef4444' : '#f97316';
  const priorityBadgeText = isSevere ? '⚠️ Severe Alert Triggered' : '⚠️ Weather Advisory Active';

  // Primary banner title
  const primaryTitle = alertTitle || `${rawCondition} Alert: ${city}`;

  // Intro paragraph
  const greetingDetail = `Our real-time monitoring system has flagged severe atmospheric conditions in <strong>${city}</strong> that require your immediate review.`;

  // Active Warnings Callout List
  const warningList = risks.length > 0 ? risks : [{
    type: 'rain',
    severity: 'severe',
    message: 'Heavy rainfall predicted with 100% probability',
    value: 100,
    forecastTime: '2026-09-06 06:00:00 UTC',
  }];

  const activeWarningsHtml = warningList.map(risk => {
    const riskIsSevere = (risk.severity || '').toLowerCase() === 'severe';
    const borderCol = riskIsSevere ? '#fca5a5' : '#fed7aa';
    const bgCol = riskIsSevere ? '#fef2f2' : '#fff7ed';
    const titleCol = riskIsSevere ? '#991b1b' : '#9a3412';
    const textCol = riskIsSevere ? '#7f1d1d' : '#7c2d12';
    const badgeBg = riskIsSevere ? '#fee2e2' : '#ffedd5';
    const badgeText = riskIsSevere ? '#b91c1c' : '#c2410c';

    const rawRiskType = (risk.type || 'Alert').replace(/_/g, ' ');
    const typeHeading = rawRiskType.toLowerCase().includes('rain') ? 'Severe Rain'
      : rawRiskType.charAt(0).toUpperCase() + rawRiskType.slice(1);

    // Probability text handling
    let probText = '';
    if (risk.value && typeof risk.value === 'number') {
      probText = `with <strong>${Math.round(risk.value)}% probability</strong>`;
    } else if (risk.value && typeof risk.value === 'string' && risk.value.includes('%')) {
      probText = `with <strong>${risk.value}</strong>`;
    } else if (risk.message && risk.message.includes('%')) {
      const match = risk.message.match(/(\d+%\s*probability)/i);
      probText = match ? `with <strong>${match[1]}</strong>` : '';
    }

    const cleanMsg = (risk.message || `${typeHeading} conditions detected`)
      .replace(/\(?\d+%\s*probability\)?/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const expectedTime = risk.forecastTime || (risk.dt_txt ? `${risk.dt_txt} UTC` : '');

    return `
        <!-- Active Warning Callout -->
        <div style="border: 1px solid ${borderCol}; background-color: ${bgCol}; border-radius: 12px; padding: 18px; margin-bottom: 24px;">
          <table width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td valign="top" style="padding-right: 12px; font-size: 20px; width: 24px;">🚨</td>
              <td>
                <h3 style="margin: 0 0 4px 0; color: ${titleCol}; font-size: 15px; font-weight: 700;">
                  Active Warning: ${typeHeading}
                </h3>
                <p style="margin: 0; font-size: 14px; color: ${textCol}; line-height: 1.5;">
                  ${cleanMsg}${probText ? ' ' + probText : ''}.<br>
                  ${expectedTime ? `
                  <span style="font-size: 12px; color: ${badgeText}; display: inline-block; margin-top: 6px; background: ${badgeBg}; padding: 2px 8px; border-radius: 4px;">
                    Predicted Horizon: ${expectedTime}
                  </span>` : ''}
                </p>
              </td>
            </tr>
          </table>
        </div>
    `.trim();
  }).join('\n\n        ');

  // Safety list
  const safetyRowsHtml = safetyTips.map(item => `
          <tr>
            <td style="padding: 6px 0; color: #475569; font-size: 14px; line-height: 1.5;">
              🔹 <strong>${item.label}:</strong> ${item.text}
            </td>
          </tr>
  `.trim()).join('\n');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rohith's Weather Watch Alert</title>
</head>
<body style="margin: 0; padding: 24px 12px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">

  <!-- Main Container -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1);">
    
    <!-- Branding & Alert Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
        <div style="font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #38bdf8; margin-bottom: 8px;">
          Rohith's Weather Watch
        </div>
        <span style="background-color: ${priorityBadgeBg}; color: #ffffff; padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; display: inline-block; margin-bottom: 12px;">
          ${priorityBadgeText}
        </span>
        <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #ffffff; line-height: 1.2;">
          ${primaryTitle}
        </h1>
      </td>
    </tr>

    <!-- Email Content Body -->
    <tr>
      <td style="padding: 28px 24px;">
        
        <p style="margin: 0 0 20px 0; font-size: 15px; color: #475569; line-height: 1.6;">
          Hello <strong>${(recipientName && recipientName.trim()) ? recipientName.trim() : 'User'}</strong>,<br>
          ${greetingDetail}
        </p>

        <!-- Current Conditions Card -->
        <table width="100%" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 24px; border-collapse: separate;">
          <tr>
            <td colspan="3" style="padding: 12px 16px; background-color: #f1f5f9; border-bottom: 1px solid #e2e8f0; border-top-left-radius: 12px; border-top-right-radius: 12px;">
              <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b;">
                Live Atmospheric Parameters
              </span>
            </td>
          </tr>
          <tr>
            <td width="33%" style="padding: 18px 12px; text-align: center; border-right: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 4px;">${conditionEmoji}</div>
              <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600;">Condition</div>
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 2px;">${rawCondition}</div>
            </td>
            <td width="33%" style="padding: 18px 12px; text-align: center; border-right: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 4px;">🌡️</div>
              <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600;">Temp</div>
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 2px;">${tempDisplay}</div>
            </td>
            <td width="33%" style="padding: 18px 12px; text-align: center;">
              <div style="font-size: 20px; margin-bottom: 4px;">💨</div>
              <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600;">Wind / Hum</div>
              <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-top: 2px;">${windDisplay} | ${humidityDisplay}</div>
            </td>
          </tr>
        </table>

        ${activeWarningsHtml}

        <!-- Actionable Safety Checklist -->
        <h3 style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.8px; color: #334155; margin: 0 0 12px 0;">
          Recommended Response Actions
        </h3>
        <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
          ${safetyRowsHtml}
        </table>

        <!-- Dashboard Button -->
        <table width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${targetDashboardUrl}" style="background-color: #0284c7; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(2, 132, 199, 0.3);">
                Launch Rohith's Weather Watch Console
              </a>
            </td>
          </tr>
        </table>

      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 24px; text-align: center; font-size: 12px; color: #94a3b8; line-height: 1.5;">
        Alert Timestamp: <strong>${formattedTime}</strong><br>
        <strong>Rohith's Weather Watch</strong> 24/7 Automated System &bull; Powered by Brevo API
      </td>
    </tr>

  </table>

</body>
</html>
  `.trim();
}

/**
 * Dispatch an email via Brevo REST API v3.
 * Uses native fetch (Node 18+ / 24) without external dependencies.
 *
 * @param {Object} options
 * @param {string} options.to          - Recipient email address
 * @param {string} [options.toName]    - Recipient name
 * @param {string} options.subject     - Email subject line
 * @param {string} options.htmlContent - HTML body content
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendBrevoEmail({ to, toName, subject, htmlContent }) {
  const config = getEmailConfig();

  if (!config.apiKey) {
    console.error('[Email] ✗ Brevo Error: BREVO_API_KEY is not set in environment.');
    return {
      success: false,
      error: 'BREVO_API_KEY is not configured in .env',
    };
  }

  if (!to || !to.includes('@')) {
    return {
      success: false,
      error: `Invalid recipient email address: "${to}"`,
    };
  }

  const payload = {
    sender: {
      name: config.senderName,
      email: config.senderEmail,
    },
    to: [
      {
        email: to.trim(),
        name: toName ? toName.trim() : 'Subscriber',
      },
    ],
    subject: subject,
    htmlContent: htmlContent,
  };

  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': config.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = data.message || `Brevo HTTP error ${res.status}: ${res.statusText}`;
      console.error(`[Email] ✗ Brevo dispatch failed for ${to}:`, errMsg);
      return { success: false, error: errMsg };
    }

    const messageId = data.messageId || 'SENT';
    console.log(`[Email] ✓ Brevo: Weather alert email sent to ${to} (MessageId: ${messageId})`);
    return { success: true, messageId };
  } catch (err) {
    console.error(`[Email] ✗ Brevo network error for ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * High-level function: Send a transactional weather alert email with duplicate cooldown prevention.
 *
 * @param {Object} params
 * @param {string} [params.recipientEmail] - Target email (falls back to ALERT_RECIPIENT_EMAIL)
 * @param {string} [params.recipientName]  - Target name
 * @param {string} params.city             - City name
 * @param {Array}  params.risks            - Detected risk items from detectRisks()
 * @param {Object} [params.weatherData]    - Current metrics (temp, condition, wind, etc.)
 * @param {boolean} [params.force]         - If true, bypass cooldown (useful for test alerts)
 * @returns {Promise<{ success: boolean, skipped?: boolean, reason?: string, messageId?: string, error?: string }>}
 */
async function sendWeatherAlertEmail({
  recipientEmail,
  recipientName = 'Subscriber',
  city,
  risks = [],
  weatherData = {},
  force = false,
  dashboardUrl,
}) {
  const config = getEmailConfig();
  const to = (recipientEmail || config.defaultRecipient || '').trim();

  if (!to) {
    console.warn(`[Email] Skipping alert email for ${city}: No recipient email specified and ALERT_RECIPIENT_EMAIL is not set.`);
    return { success: false, error: 'No recipient email configured.' };
  }

  if (!risks || risks.length === 0) {
    return { success: true, skipped: true, reason: 'No risks to alert.' };
  }

  // Check cooldown for each risk type
  const activeRisksToSend = [];
  for (const risk of risks) {
    const riskType = risk.type || 'general';
    if (!force) {
      const { active, remainingMinutes } = checkCooldown(to, city, riskType);
      if (active) {
        console.log(`[Email] Cooldown active for ${to} on "${riskType}" in ${city} (${remainingMinutes}m remaining). Skipping duplicate.`);
        continue;
      }
    }
    activeRisksToSend.push(risk);
  }

  if (activeRisksToSend.length === 0) {
    return {
      success: true,
      skipped: true,
      reason: 'All detected risks are currently on cooldown for this recipient.',
    };
  }

  const primaryRisk = activeRisksToSend[0];
  const rawType = (primaryRisk?.type || 'Weather').replace(/_/g, ' ');
  const riskTitlePart = rawType.toLowerCase().includes('rain') ? 'Heavy Rain'
    : rawType.toLowerCase().includes('thunder') ? 'Thunderstorm'
    : rawType.toLowerCase().includes('heat') ? 'High Heat'
    : rawType.toLowerCase().includes('wind') ? 'High Wind'
    : rawType.charAt(0).toUpperCase() + rawType.slice(1);
  const alertTitle = `${riskTitlePart} Alert: ${city}`;
  const subject = `⚠️ ${riskTitlePart} Alert: ${city}`;

  const htmlContent = buildAlertEmailHtml({
    alertTitle,
    city,
    risks: activeRisksToSend,
    weatherData,
    recipientName,
    dashboardUrl,
  });

  const result = await sendBrevoEmail({
    to,
    toName: recipientName,
    subject,
    htmlContent,
  });

  if (result.success) {
    // Record sent alerts in cooldown tracker
    for (const risk of activeRisksToSend) {
      recordAlertSent(to, city, risk.type || 'general');
    }
  }

  return result;
}

/**
 * Helper to dispatch a safe test weather alert email.
 *
 * @param {Object} options
 * @param {string} [options.email] - Optional test recipient
 * @param {string} [options.city]  - Optional test city (defaults to Nepal)
 * @param {string} [options.name]  - Optional test recipient username
 * @returns {Promise<Object>}
 */
async function sendTestWeatherAlertEmail({ email, city = 'Nepal', name, dashboardUrl } = {}) {
  const config = getEmailConfig();
  const targetEmail = (email || config.defaultRecipient || config.senderEmail).trim();
  const targetName  = (name && name.trim()) ? name.trim() : 'User';

  const mockRisks = [
    {
      type: 'rain',
      severity: 'severe',
      message: 'Heavy rainfall predicted',
      value: 100,
      forecastTime: '2026-09-06 06:00:00 UTC',
      impact: 'High rainfall intensity expected. Potential localized flooding and reduced road visibility.',
    },
  ];

  const mockWeatherData = {
    temp: 25,
    condition: 'Rain',
    windSpeed: 4,
    humidity: 80,
  };

  console.log(`[Test Email] Dispatching test weather alert to: ${targetEmail} (Name: ${targetName})`);

  return sendWeatherAlertEmail({
    recipientEmail: targetEmail,
    recipientName: targetName,
    city,
    risks: mockRisks,
    weatherData: mockWeatherData,
    force: true, // bypass cooldown for testing
    dashboardUrl,
  });
}

module.exports = {
  sendBrevoEmail,
  sendWeatherAlertEmail,
  sendTestWeatherAlertEmail,
  checkCooldown,
  recordAlertSent,
  clearCooldownCache,
  isEmailConfigured,
  getEmailConfig,
  buildAlertEmailHtml,
};
