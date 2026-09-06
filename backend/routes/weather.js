'use strict';

const express = require('express');
const router = express.Router();
const { getDashboardWeather } = require('../services/weatherService');

// ---------------------------------------------------------------------------
// Error Handler Helper
// ---------------------------------------------------------------------------
function handleRouteError(err, res, context) {
  console.error(`[Weather API Error] ${context}:`, err.message);
  if (err.code === 'MISSING_API_KEY') {
    return res.status(503).json({
      error: 'WEATHER_API_KEY is not set in .env. Please add your OpenWeatherMap API key in .env file to enable live weather data.'
    });
  }
  if (err.status === 404 || err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('city not found')) {
    return res.status(404).json({
      error: 'City not found. Please verify the city name and try again.'
    });
  }
  if (err.status === 401 || err.message.toLowerCase().includes('invalid api key')) {
    return res.status(401).json({
      error: 'Invalid OpenWeatherMap API key. Please check the WEATHER_API_KEY value in your .env file.'
    });
  }
  return res.status(500).json({
    error: err.message || 'An error occurred while fetching weather data.'
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/weather?city=Sathyamangalam
 * GET /api/weather?lat=11.50&lon=77.23
 *
 * Primary unified endpoint: returns current weather, 24h hourly forecast, 5-day daily forecast, and risk items.
 */
async function handleWeatherRequest(req, res) {
  const { city, lat, lon } = req.query;

  if (lat !== undefined && lon !== undefined) {
    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    if (isNaN(parsedLat) || isNaN(parsedLon)) {
      return res.status(400).json({ error: 'Latitude and Longitude must be valid numbers.' });
    }
    try {
      const data = await getDashboardWeather({ lat: parsedLat, lon: parsedLon });
      return res.json(data);
    } catch (err) {
      return handleRouteError(err, res, 'GET / (coords)');
    }
  }

  if (!city || city.trim().length < 2) {
    return res.status(400).json({ error: 'Please enter a valid city name.' });
  }

  try {
    const data = await getDashboardWeather({ city: city.trim() });
    return res.json(data);
  } catch (err) {
    return handleRouteError(err, res, `GET /?city=${city}`);
  }
}

router.get('/', handleWeatherRequest);
router.get('/dashboard', handleWeatherRequest);

module.exports = router;
