'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { runMonitoringCycle } = require('../scheduler/monitorJob');

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const stmts = {
  findByEmail:   db.prepare(`SELECT id FROM users WHERE email = ?`),
  insert:        db.prepare(`
    INSERT INTO users (name, email, city, city_normalized, alert_rain, alert_heat, alert_wind, alert_thunder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateByEmail: db.prepare(`
    UPDATE users
    SET name = ?, city = ?, city_normalized = ?,
        alert_rain = ?, alert_heat = ?, alert_wind = ?, alert_thunder = ?
    WHERE email = ?
  `),
  statusByEmail: db.prepare(`
    SELECT name, email, city, alert_rain, alert_heat, alert_wind, alert_thunder, snooze_until
    FROM users WHERE email = ?
  `),
  setSnooze: db.prepare(`UPDATE users SET snooze_until = ? WHERE email = ?`),
  // Note: findByEmail is reused for ID lookup — no duplicate needed
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const normaliseCity  = city => city.trim().toLowerCase();
const isValidEmail   = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || '').trim());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/users/register
 * Upsert a user by email address.
 * Body: { name, email, city, preferences: { rain, heat, wind, thunder } }
 */
router.post('/register', (req, res) => {
  const { name, email, city, preferences = {} } = req.body;

  if (!name || !email || !city) {
    return res.status(400).json({ error: 'Name, email, and city are required.' });
  }
  if (name.trim().length < 2) {
    return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address (e.g. name@example.com).' });
  }
  if (city.trim().length < 2) {
    return res.status(400).json({ error: 'City name must be at least 2 characters.' });
  }

  const alertRain    = preferences.rain    ? 1 : 0;
  const alertHeat    = preferences.heat    ? 1 : 0;
  const alertWind    = preferences.wind    ? 1 : 0;
  const alertThunder = preferences.thunder ? 1 : 0;

  if (alertRain + alertHeat + alertWind + alertThunder === 0) {
    return res.status(400).json({ error: 'Select at least one weather alert category.' });
  }

  const cleanName  = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanCity  = city.trim();
  const normCity   = normaliseCity(city);

  try {
    const existing = stmts.findByEmail.get(cleanEmail);

    if (existing) {
      stmts.updateByEmail.run(cleanName, cleanCity, normCity, alertRain, alertHeat, alertWind, alertThunder, cleanEmail);
      setImmediate(() => runMonitoringCycle().catch(err => console.error('[Register] Monitor error:', err.message)));
      return res.json({
        success: true,
        action: 'updated',
        message: 'Your weather email alert preferences have been updated.',
      });
    }

    stmts.insert.run(cleanName, cleanEmail, cleanCity, normCity, alertRain, alertHeat, alertWind, alertThunder);
    setImmediate(() => runMonitoringCycle().catch(err => console.error('[Register] Monitor error:', err.message)));
    return res.status(201).json({
      success: true,
      action: 'created',
      message: 'Registered! You will receive email alerts when severe weather is detected.',
    });
  } catch (err) {
    console.error('[Route] POST /users/register:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

/**
 * GET /api/users/status?email=user@example.com
 * Returns registration info to pre-fill the form on return visits.
 */
router.get('/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email parameter is required.' });

  const user = stmts.statusByEmail.get(email.trim().toLowerCase());
  if (!user) return res.json({ registered: false });

  res.json({
    registered: true,
    name:  user.name,
    email: user.email,
    city:  user.city,
    preferences: {
      rain:    user.alert_rain    === 1,
      heat:    user.alert_heat    === 1,
      wind:    user.alert_wind    === 1,
      thunder: user.alert_thunder === 1,
    },
    snoozeUntil: user.snooze_until || null,
  });
});

/**
 * POST /api/users/snooze
 * Set or clear the alert snooze window for a registered user.
 * Body: { email, snoozeUntil }  — snoozeUntil is an ISO timestamp string or null/"" to un-snooze.
 */
router.post('/snooze', (req, res) => {
  const { email, snoozeUntil } = req.body || {};

  if (!email) return res.status(400).json({ error: 'email is required.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address.' });

  const cleanEmail = email.trim().toLowerCase();
  const user = stmts.findByEmail.get(cleanEmail);
  if (!user) return res.status(404).json({ error: 'No registered user found for that email.' });

  // Accept null / empty string to clear the snooze
  let snoozeValue = null;
  if (snoozeUntil) {
    const parsed = new Date(snoozeUntil);
    if (isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'snoozeUntil must be a valid ISO timestamp or null.' });
    }
    if (parsed <= new Date()) {
      return res.status(400).json({ error: 'snoozeUntil must be a future date/time.' });
    }
    snoozeValue = parsed.toISOString();
  }

  try {
    stmts.setSnooze.run(snoozeValue, cleanEmail);
    return res.json({
      success: true,
      snoozeUntil: snoozeValue,
      message: snoozeValue
        ? `Alerts snoozed until ${new Date(snoozeValue).toLocaleString()}.`
        : 'Alert snooze cleared. Alerts are now active.',
    });
  } catch (err) {
    console.error('[Route] POST /users/snooze:', err.message);
    res.status(500).json({ error: 'Failed to update snooze setting.' });
  }
});

/**
 * DELETE /api/users
 * Remove a registered user by email address.
 * Query or Body: { email }
 */
router.delete('/', (req, res) => {
  const email = (req.query.email || req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required.' });

  try {
    const user = stmts.findByEmail.get(email);
    if (!user) {
      return res.json({ success: true, message: 'User already removed or not found.' });
    }
    db.prepare('DELETE FROM users WHERE email = ?').run(email);
    return res.json({ success: true, message: 'User successfully unsubscribed and deleted.' });
  } catch (err) {
    console.error('[Route] DELETE /users:', err.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

module.exports = router;
