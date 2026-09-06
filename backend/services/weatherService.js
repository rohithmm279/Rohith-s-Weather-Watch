'use strict';

// Note: dotenv is loaded by server.js at startup — process.env is already populated.
const { detectRisks, getOverallRiskLevel, msToKmh } = require('./riskDetection');

const BASE_URL = 'https://api.openweathermap.org/data/2.5';

// Cache TTL — computed once at module load to avoid re-parsing env on every request.
// Call reloadCacheTtl() if you need to update it at runtime.
let WEATHER_CACHE_TTL_MS = (parseInt(process.env.WEATHER_CACHE_TTL_MINUTES, 10) || 10) * 60 * 1000;
function reloadCacheTtl() {
  WEATHER_CACHE_TTL_MS = (parseInt(process.env.WEATHER_CACHE_TTL_MINUTES, 10) || 10) * 60 * 1000;
}

const MAX_CACHE_SIZE = 100;

// Unified in-memory cache: normalizedKey -> { data, fetchedAt }
const weatherCache = new Map();

// In-flight request deduplication: normalizedKey -> Promise<data>
const inFlightRequests = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey() {
  const key = process.env.WEATHER_API_KEY ? process.env.WEATHER_API_KEY.trim() : '';
  if (!key) {
    const err = new Error('WEATHER_API_KEY is not set in .env');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  return key;
}

function normalizeCityKey(city) {
  return `city:${city.trim().toLowerCase()}`;
}

function normalizeCoordsKey(lat, lon) {
  const roundedLat = parseFloat(lat).toFixed(2);
  const roundedLon = parseFloat(lon).toFixed(2);
  return `coords:${roundedLat},${roundedLon}`;
}

async function owmFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.message || `OpenWeatherMap returned status ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function getFromCache(key) {
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL_MS) {
    return cached.data;
  }
  if (cached) {
    weatherCache.delete(key);
  }
  return null;
}

function setInCache(key, data) {
  if (weatherCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = weatherCache.keys().next().value;
    if (oldestKey) weatherCache.delete(oldestKey);
  }
  weatherCache.set(key, { data, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Core Fetchers (External API)
// ---------------------------------------------------------------------------

function fetchRawCurrentByCity(city) {
  const url = `${BASE_URL}/weather?q=${encodeURIComponent(city.trim())}&appid=${getApiKey()}&units=metric`;
  return owmFetch(url);
}

function fetchRawCurrentByCoords(lat, lon) {
  const url = `${BASE_URL}/weather?lat=${lat}&lon=${lon}&appid=${getApiKey()}&units=metric`;
  return owmFetch(url);
}

function fetchRawForecastByCity(city) {
  const url = `${BASE_URL}/forecast?q=${encodeURIComponent(city.trim())}&appid=${getApiKey()}&units=metric`;
  return owmFetch(url);
}

function fetchRawForecastByCoords(lat, lon) {
  const url = `${BASE_URL}/forecast?lat=${lat}&lon=${lon}&appid=${getApiKey()}&units=metric`;
  return owmFetch(url);
}

// ---------------------------------------------------------------------------
// Dashboard Aggregator (Unified single response with parallel execution)
// ---------------------------------------------------------------------------

/**
 * Magnus formula: estimate dew point from temperature (°C) and relative humidity (%).
 */
function calcDewPoint(tempC, humidity) {
  const a = 17.625, b = 243.04;
  const gamma = (a * tempC) / (b + tempC) + Math.log(humidity / 100);
  return parseFloat((b * gamma / (a - gamma)).toFixed(1));
}

/**
 * Groups 3-hourly forecast items by calendar date to create 5-6 day summary.
 */
function aggregateDailyForecast(list) {
  if (!list || !Array.isArray(list)) return [];
  const dayMap = new Map();

  list.forEach(item => {
    const dateKey = item.dt_txt ? item.dt_txt.split(' ')[0] : '';
    if (!dateKey) return;
    if (!dayMap.has(dateKey)) {
      dayMap.set(dateKey, []);
    }
    dayMap.get(dateKey).push(item);
  });

  const todayKey = new Date().toISOString().split('T')[0];

  return Array.from(dayMap.entries()).slice(0, 6).map(([dateKey, items]) => {
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    let maxPop = 0;

    items.forEach(it => {
      if (it.main.temp_min < minTemp) minTemp = it.main.temp_min;
      if (it.main.temp_max > maxTemp) maxTemp = it.main.temp_max;
      const p = Math.round((it.pop || 0) * 100);
      if (p > maxPop) maxPop = p;
    });

    // Pick midday item (approx 12:00:00) or middle item
    const middayItem = items.find(it => it.dt_txt.includes('12:00:00')) || items[Math.floor(items.length / 2)];
    const cond = middayItem && middayItem.weather && middayItem.weather[0] ? middayItem.weather[0].main : 'Clear';
    const desc = middayItem && middayItem.weather && middayItem.weather[0] ? middayItem.weather[0].description : '';
    const icon = middayItem && middayItem.weather && middayItem.weather[0] ? middayItem.weather[0].icon : '01d';

    const d = new Date(dateKey + 'T12:00:00');
    const dayName = dateKey === todayKey ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' });

    return {
      date: dateKey,
      dayName,
      tempMin: Math.round(minTemp),
      tempMax: Math.round(maxTemp),
      condition: cond,
      description: desc,
      icon,
      pop: maxPop,
    };
  });
}

/**
 * Approximates UV Index from solar elevation, latitude, time of day, and cloud cover.
 * 0-2: Low, 3-5: Moderate, 6-7: High, 8-10: Very High, 11+: Extreme
 */
function estimateUvIndex(lat, clouds, dt, sunrise, sunset) {
  if (!sunrise || !sunset || !dt || dt < sunrise || dt > sunset) return 0;
  const solarNoon = (sunrise + sunset) / 2;
  const halfDay = Math.max(1, (sunset - sunrise) / 2);
  const distFromNoon = Math.min(1, Math.abs(dt - solarNoon) / halfDay);
  
  // Latitude attenuation (tropics = higher baseline, poles = lower)
  const absLat = Math.abs(lat != null ? lat : 20);
  const maxPotentialUv = Math.max(3, 11 - (absLat / 10));
  
  // Elevation curve peaking at solar noon
  const elevationFactor = Math.cos((distFromNoon * Math.PI) / 2);
  
  // Cloud attenuation factor (100% overcast reduces UV by ~60%)
  const cloudFactor = 1 - Math.min(0.65, ((clouds != null ? clouds : 0) / 100) * 0.65);
  
  const uv = maxPotentialUv * elevationFactor * cloudFactor;
  return Math.max(0, parseFloat(uv.toFixed(1)));
}

/**
 * Normalizes raw current weather & forecast into a clean, compact payload.
 */
function buildDashboardPayload(rawCurrent, rawForecast) {
  const sunrise = rawCurrent.sys && rawCurrent.sys.sunrise;
  const sunset = rawCurrent.sys && rawCurrent.sys.sunset;
  const lat = rawCurrent.coord && rawCurrent.coord.lat;
  const clouds = rawCurrent.clouds && rawCurrent.clouds.all;
  const dt = rawCurrent.dt || Math.floor(Date.now() / 1000);

  const current = {
    city: rawCurrent.name,
    country: (rawCurrent.sys && rawCurrent.sys.country) || '',
    temp: parseFloat(rawCurrent.main.temp.toFixed(1)),
    feelsLike: parseFloat(rawCurrent.main.feels_like.toFixed(1)),
    humidity: rawCurrent.main.humidity,
    windKmh: parseFloat(msToKmh(rawCurrent.wind.speed).toFixed(1)),
    condition: rawCurrent.weather && rawCurrent.weather[0] ? rawCurrent.weather[0].main : 'Unknown',
    description: rawCurrent.weather && rawCurrent.weather[0] ? rawCurrent.weather[0].description : '',
    icon: rawCurrent.weather && rawCurrent.weather[0] ? rawCurrent.weather[0].icon : '01d',
    // Extended metrics (from existing OWM response — no extra API calls)
    pressure: rawCurrent.main.pressure || null,
    visibility: rawCurrent.visibility != null
      ? Math.min(parseFloat((rawCurrent.visibility / 1000).toFixed(1)), 10)
      : null,
    dewPoint: calcDewPoint(rawCurrent.main.temp, rawCurrent.main.humidity),
    uvIndex: estimateUvIndex(lat, clouds, dt, sunrise, sunset),
  };

  // Hourly forecast strip (next 8 intervals = 24 hours)
  const hourly = (rawForecast.list || []).slice(0, 8).map(p => ({
    time: p.dt_txt,
    temp: parseFloat(p.main.temp.toFixed(1)),
    condition: p.weather && p.weather[0] ? p.weather[0].main : 'Unknown',
    description: p.weather && p.weather[0] ? p.weather[0].description : '',
    icon: p.weather && p.weather[0] ? p.weather[0].icon : '01d',
    pop: Math.round((p.pop || 0) * 100),
    windKmh: parseFloat(msToKmh(p.wind.speed).toFixed(1)),
    humidity: p.main.humidity,
  }));

  // Daily multi-day forecast (5-6 days)
  const daily = aggregateDailyForecast(rawForecast.list || []);

  const items = detectRisks(rawForecast);
  const level = getOverallRiskLevel(items);

  // Cross-compatibility fields for dashboard render & background animations
  current.name = rawCurrent.name;
  current.sys = rawCurrent.sys || { country: current.country };
  current.main = {
    temp: current.temp,
    feels_like: current.feelsLike,
    humidity: current.humidity,
    pressure: current.pressure,
  };
  current.weather = rawCurrent.weather || [{
    main: current.condition,
    description: current.description,
    icon: current.icon,
  }];
  current.wind = rawCurrent.wind || {
    speed: rawCurrent.wind?.speed || (current.windKmh / 3.6),
    deg: rawCurrent.wind?.deg,
  };
  current.riskLevel = level;

  return {
    current,
    hourly,
    daily,
    forecast: rawForecast,
    risk: {
      level,
      items,
    },
  };
}

/**
 * Fetch unified dashboard data by city or coordinates with caching & deduplication.
 */
async function getDashboardWeather({ city, lat, lon }) {
  const isCoords = lat !== undefined && lon !== undefined;
  const primaryKey = isCoords ? normalizeCoordsKey(lat, lon) : normalizeCityKey(city);

  // 1. Check in-memory cache
  const cached = getFromCache(primaryKey);
  if (cached) {
    return cached;
  }

  // 2. In-flight request deduplication
  if (inFlightRequests.has(primaryKey)) {
    return inFlightRequests.get(primaryKey);
  }

  // 3. Create parallel fetch promise
  const fetchPromise = (async () => {
    try {
      const [rawCurrent, rawForecast] = await Promise.all([
        isCoords ? fetchRawCurrentByCoords(lat, lon) : fetchRawCurrentByCity(city),
        isCoords ? fetchRawForecastByCoords(lat, lon) : fetchRawForecastByCity(city),
      ]);

      const payload = buildDashboardPayload(rawCurrent, rawForecast);

      // Cache by primary key
      setInCache(primaryKey, payload);

      // Also cache by normalized city name if query was coords
      if (isCoords && rawCurrent.name) {
        setInCache(normalizeCityKey(rawCurrent.name), payload);
      }

      return payload;
    } finally {
      inFlightRequests.delete(primaryKey);
    }
  })();

  inFlightRequests.set(primaryKey, fetchPromise);
  return fetchPromise;
}

module.exports = {
  getDashboardWeather,
  fetchRawForecastByCity,
  fetchRawCurrentByCity,
  reloadCacheTtl,
};
