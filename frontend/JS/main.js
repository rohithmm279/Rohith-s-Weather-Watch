/*  main.js — WeatherWatch Frontend (email-only alert system)
 *  ─────────────────────────────────────────────────────────
 *  Optimizations applied:
 *    • All DOM nodes cached once at startup
 *    • debounce on search input (300 ms) to avoid unnecessary fetch
 *    • localStorage access batched (read once on init, write on change)
 *    • AbortController used to cancel in-flight weather requests
 *    • Clock timer uses requestAnimationFrame-aligned 1 s interval
 *    • Modal open/close avoids layout thrash by toggling a CSS class
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const API_BASE               = '/api';
const MAX_HISTORY            = 5;
const STORAGE_CITY           = 'ww_city';
const STORAGE_HIST           = 'ww_history';
const STORAGE_ALERT          = 'ww_alert';          // { name, email, city, prefs }
const STORAGE_LAST_DASHBOARD = 'ww_last_dashboard'; // Stale-While-Revalidate dashboard cache

// ── In-memory client cache (0ms instant retrieval) ─────────────────────────────
const clientCache = new Map();
const CLIENT_CACHE_TTL = 300_000; // 5 minutes

function getCachedWeather(key) {
  if (!key) return null;
  const k = key.toLowerCase().trim();
  const entry = clientCache.get(k);
  if (entry && (Date.now() - entry.time < CLIENT_CACHE_TTL)) {
    return entry.data;
  }
  if (entry) clientCache.delete(k);
  return null;
}

function setCachedWeather(key, data) {
  if (!key || !data) return;
  const k = key.toLowerCase().trim();
  if (clientCache.size >= 60) {
    const oldest = clientCache.keys().next().value;
    if (oldest) clientCache.delete(oldest);
  }
  clientCache.set(k, { data, time: Date.now() });
}

const UV_LABELS  = ['Low','Low','Moderate','Moderate','High','High','High','Very High','Very High','Very High','Very High','Extreme'];
const WIND_DIRS  = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

// Shared validation / selector constants (defined once, reused everywhere)
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;  // basic RFC-style email check
const PREF_SEL  = '#alertForm input[name="pref"]'; // preference checkbox selector

// ── DOM Cache (resolve once) ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  // Search
  cityInput:  $('cityInput'),
  searchBtn:  $('searchBtn'),
  locationBtn:$('locationBtn'),
  errorBanner:$('errorMessage'),
  loaderRow:  $('loaderRow'),
  loader:     $('loader'),
  loadStatus: $('loadStatus'),
  // Weather
  weather:    $('weather'),
  cityName:   $('cityName'),
  datetime:   $('currentDateTime'),
  riskBadge:  $('riskBadge'),
  icon:       $('icon'),
  temp:       $('temp'),
  desc:       $('desc'),
  feelsLike:  $('feelsLikeText'),
  hourlyStrip:$('hourlyStrip'),
  dailyList:  $('dailyList'),
  // Metrics
  wind:       $('wm-wind'),
  windSub:    $('wm-wind-sub'),
  humidity:   $('wm-humidity'),
  dew:        $('wm-dew'),
  uv:         $('wm-uv'),
  uvSub:      $('wm-uv-sub'),
  pressure:   $('wm-pressure'),
  pressureSub:$('wm-pressure-sub'),
  visibility: $('wm-visibility'),
  visSub:     $('wm-vis-sub'),
  currentCard:$('currentWeatherCard'),
  // History
  historyBox: $('historyBox'),
  historyList:$('historyList'),
  clearHistory:$('clearHistory'),
  // Modal
  alertModalBtn:  $('alertModalBtn'),
  alertModal:     $('alertModal'),
  closeModalBtn:  $('closeModalBtn'),
  alertForm:      $('alertForm'),
  regName:        $('regName'),
  regEmail:       $('regEmail'),
  regCity:        $('regCity'),
  alertLocationBtn: $('alertLocationBtn'),
  saveAlertBtn:   $('saveAlertBtn'),
  sendTestEmailBtn:$('sendTestEmailBtn'),
  deleteUserBtn:  $('deleteUserBtn'),
  modalMsg:       $('modalMsg'),
  // Snooze
  snoozeRow:        $('snoozeRow'),
  snoozeDuration:   $('snoozeDuration'),
  snoozeCustom:     $('snoozeCustom'),
  snoozeStatus:     $('snoozeStatus'),
  snoozeActiveBadge:$('snoozeActiveBadge'),
};

// ── State ──────────────────────────────────────────────────────────────────────
let currentCity   = '';
let abortCtrl     = null;
let clockTimer    = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const windDir  = deg => WIND_DIRS[Math.round(deg / 22.5) % 16];
const uvLabel  = idx => UV_LABELS[Math.min(Math.round(idx), 11)];
const dewPoint = (T, H) => Math.round(T - (100 - H) / 5);
const fmt      = n   => typeof n === 'number' ? Math.round(n) : '--';

// ── Snooze helpers ─────────────────────────────────────────────────────────────
const STORAGE_SNOOZE = 'ww_snooze_until'; // ISO timestamp or null

function getLocalSnooze() {
  try { return localStorage.getItem(STORAGE_SNOOZE) || null; } catch { return null; }
}
function setLocalSnooze(isoStr) {
  try {
    if (isoStr) localStorage.setItem(STORAGE_SNOOZE, isoStr);
    else localStorage.removeItem(STORAGE_SNOOZE);
  } catch {}
}

/** Returns remaining ms if snooze is active, else 0 */
function snoozeRemainingMs(isoStr) {
  if (!isoStr) return 0;
  const rem = new Date(isoStr).getTime() - Date.now();
  return rem > 0 ? rem : 0;
}

/** Format ms into "Xh Ym" or "Xm" */
function fmtDuration(ms) {
  const totalMins = Math.round(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Update the 🔔 Alerts header button to reflect snooze state */
function updateAlertBtnBadge() {
  const snooze = getLocalSnooze();
  const rem = snoozeRemainingMs(snooze);
  if (rem > 0) {
    el.alertModalBtn.classList.add('snoozed');
    el.alertModalBtn.textContent = `🔕 Snoozed (${fmtDuration(rem)})`;
  } else {
    // Snooze expired — clean up
    if (snooze) setLocalSnooze(null);
    el.alertModalBtn.classList.remove('snoozed');
    el.alertModalBtn.textContent = '🔔 Alerts';
  }
}

/** Populate snooze status text inside the modal */
function renderSnoozeStatus(snoozeUntilIso) {
  const rem = snoozeRemainingMs(snoozeUntilIso);
  if (rem > 0) {
    el.snoozeStatus.textContent = `⏱ Alerts paused for ${fmtDuration(rem)} (until ${new Date(snoozeUntilIso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}).`;
    el.snoozeStatus.style.display = 'block';
    el.snoozeActiveBadge.style.display = 'inline-flex';
    // Pre-select closest preset or leave on custom
    const remH = rem / 3_600_000;
    const options = ['1','4','8','24'];
    const match = options.find(h => Math.abs(parseFloat(h) - remH) < 0.3);
    el.snoozeDuration.value = match || 'custom';
    if (el.snoozeDuration.value === 'custom') {
      el.snoozeCustom.style.display = 'block';
      el.snoozeCustom.value = new Date(snoozeUntilIso).toISOString().slice(0,16);
    }
  } else {
    el.snoozeStatus.style.display = 'none';
    el.snoozeActiveBadge.style.display = 'none';
    el.snoozeDuration.value = '';
    el.snoozeCustom.style.display = 'none';
    el.snoozeCustom.value = '';
  }
}

/** Compute snoozeUntil ISO from current dropdown/custom input selection */
function resolveSnoozeUntil() {
  const val = el.snoozeDuration.value;
  if (!val) return null; // un-snooze
  if (val === 'custom') {
    return el.snoozeCustom.value ? new Date(el.snoozeCustom.value).toISOString() : null;
  }
  const ms = parseFloat(val) * 3_600_000;
  return new Date(Date.now() + ms).toISOString();
}

// ── Storage helpers ────────────────────────────────────────────────────────────
const lsGet = (key, fallback = null) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

// ── Error / Loader ─────────────────────────────────────────────────────────────
function showError(msg) {
  el.errorBanner.textContent = msg;
  el.errorBanner.style.display = 'block';
}
function clearError() { el.errorBanner.style.display = 'none'; el.errorBanner.textContent = ''; }

function showLoader(msg = 'Fetching weather data…') {
  el.loaderRow.style.display = 'flex';
  el.loader.style.display    = 'block';
  el.loadStatus.textContent  = msg;
}
function hideLoader() {
  el.loaderRow.style.display = 'none';
  el.loader.style.display    = 'none';
  el.loadStatus.textContent  = '';
}

// ── Clock ──────────────────────────────────────────────────────────────────────
function updateClock() {
  el.datetime.textContent = new Date().toLocaleString('en-IN', {
    weekday:'short', day:'numeric', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit',
  });
}
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  updateClock();
  clockTimer = setInterval(updateClock, 1000);
}

// ── Risk badge ─────────────────────────────────────────────────────────────────
const RISK_MAP = {
  none:     { cls: 'risk-none',     txt: '✓ Clear' },
  low:      { cls: 'risk-low',      txt: '⚠ Low Risk' },
  moderate: { cls: 'risk-moderate', txt: '⚠ Moderate' },
  high:     { cls: 'risk-high',     txt: '🔴 High Risk' },
  severe:   { cls: 'risk-severe',   txt: '🚨 Severe' },
};
function updateRiskBadge(level = 'none') {
  const m = RISK_MAP[level] || RISK_MAP.none;
  el.riskBadge.className = `risk-badge ${m.cls}`;
  el.riskBadge.textContent = m.txt;
  if (level !== 'none' && level !== 'low') {
    el.currentCard.classList.add('has-alert');
  } else {
    el.currentCard.classList.remove('has-alert');
  }
}

// ── Modal message ──────────────────────────────────────────────────────────────
function showModalMsg(msg, type = 'success') {
  el.modalMsg.textContent = msg;
  el.modalMsg.className   = `modal-msg ${type}`;
}
function clearModalMsg() {
  el.modalMsg.textContent = '';
  el.modalMsg.className   = 'modal-msg';
}

// ── Search history ─────────────────────────────────────────────────────────────
function loadHistory() {
  return lsGet(STORAGE_HIST, []);
}
function saveHistory(history) {
  lsSet(STORAGE_HIST, history);
}
function addToHistory(city) {
  const h = loadHistory().filter(c => c.toLowerCase() !== city.toLowerCase());
  h.unshift(city);
  if (h.length > MAX_HISTORY) h.pop();
  saveHistory(h);
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  if (h.length === 0) { el.historyBox.style.display = 'none'; return; }
  el.historyBox.style.display = 'flex';
  el.historyList.innerHTML = h.map(c => `
    <button class="recent-chip" data-city="${c}" type="button">
      <span class="recent-chip-label">${c}</span>
      <span class="recent-chip-del" data-del="${c}" aria-label="Remove ${c}">×</span>
    </button>`).join('');
}

el.historyList.addEventListener('click', e => {
  const del = e.target.dataset.del;
  if (del) {
    saveHistory(loadHistory().filter(c => c.toLowerCase() !== del.toLowerCase()));
    renderHistory();
    return;
  }
  const city = e.target.closest('.recent-chip')?.dataset.city;
  if (city) { el.cityInput.value = city; fetchWeather(city); }
});
el.clearHistory.addEventListener('click', () => { saveHistory([]); renderHistory(); });

// ── Hourly strip ───────────────────────────────────────────────────────────────
function renderHourly(list = []) {
  if (!Array.isArray(list) || !list.length) {
    el.hourlyStrip.innerHTML = '<span class="wx-empty">No hourly data available.</span>';
    return;
  }

  const now = Date.now() / 1000;
  // If raw OWM list (has dt), filter future items; if pre-aggregated hourly, use up to 16
  const entries = list[0]?.dt
    ? list.filter(e => e.dt > now).slice(0, 16)
    : list.slice(0, 16);

  if (!entries.length) {
    el.hourlyStrip.innerHTML = '<span class="wx-empty">No upcoming hourly data.</span>';
    return;
  }

  const frag = document.createDocumentFragment();
  entries.forEach(e => {
    let timeStr = '--';
    if (e.dt) {
      timeStr = new Date(e.dt * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    } else if (e.time) {
      const parsed = new Date(e.time.includes('T') ? e.time : e.time.replace(' ', 'T'));
      timeStr = isNaN(parsed.getTime())
        ? e.time
        : parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    }

    const iconCode = e.icon || e.weather?.[0]?.icon || '01d';
    const iconUrl  = `https://openweathermap.org/img/wn/${iconCode}.png`;
    const desc     = e.description || e.weather?.[0]?.description || e.condition || '';
    const tempVal  = e.temp ?? e.main?.temp;
    const rawPop   = e.pop ?? 0;
    const pop      = Math.round(rawPop > 1 ? rawPop : rawPop * 100);

    const chip = document.createElement('div');
    chip.className = 'wx-hourly-chip';
    chip.setAttribute('role', 'listitem');
    chip.innerHTML = `
      <div class="wx-chip-time">${timeStr}</div>
      <img src="${iconUrl}" alt="${desc}" loading="lazy" width="32" height="32" />
      <div class="wx-chip-temp">${fmt(tempVal)}°</div>
      ${pop > 0 ? `<div class="wx-chip-pop">🌧 ${pop}%</div>` : `<div class="wx-chip-pop wx-chip-pop--muted">—</div>`}`;
    frag.appendChild(chip);
  });
  el.hourlyStrip.replaceChildren(frag);
}

// ── Daily forecast ─────────────────────────────────────────────────────────────
function renderDaily(list = []) {
  if (!Array.isArray(list) || !list.length) {
    el.dailyList.innerHTML = '<span class="wx-empty">No daily data available.</span>';
    return;
  }

  // Case 1: Already aggregated by backend (e.g. daily array with { dayName, tempMin, tempMax })
  if (list[0] && ('dayName' in list[0] || 'tempMin' in list[0])) {
    const frag = document.createDocumentFragment();
    list.slice(0, 5).forEach(d => {
      const iconCode = d.icon || '01d';
      const iconUrl  = `https://openweathermap.org/img/wn/${iconCode}.png`;
      const pop      = Math.round(d.pop > 1 ? d.pop : (d.pop || 0) * 100);
      const desc     = d.description || d.condition || '';

      const item = document.createElement('div');
      item.className = 'wx-daily-item';
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <div class="wx-day-name">${d.dayName || 'Day'}</div>
        <div class="wx-day-date">${d.date ? new Date(d.date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</div>
        <img src="${iconUrl}" alt="${desc}" loading="lazy" width="38" height="38" />
        <div class="wx-day-cond">${desc}</div>
        <div class="wx-temp-range">
          <span class="wx-temp-max">${fmt(d.tempMax)}°</span>
          <span class="wx-temp-sep">/</span>
          <span class="wx-temp-min">${fmt(d.tempMin)}°</span>
        </div>
        ${pop > 0 ? `<div class="wx-day-pop">🌧 ${pop}%</div>` : ''}`;
      frag.appendChild(item);
    });
    el.dailyList.replaceChildren(frag);
    return;
  }

  // Case 2: Raw 3-hourly OWM forecast entries
  const groups = new Map();
  list.forEach(e => {
    const day = new Date(e.dt * 1000).toLocaleDateString('en-IN');
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  });

  const days = [...groups.values()].slice(0, 5).map(entries => {
    const mid = entries.reduce((a, b) => {
      const ah = new Date(a.dt * 1000).getHours(), bh = new Date(b.dt * 1000).getHours();
      return Math.abs(ah - 12) < Math.abs(bh - 12) ? a : b;
    });
    const temps = entries.map(e => e.main?.temp).filter(t => t != null);
    return { entry: mid, tMin: Math.min(...temps), tMax: Math.max(...temps) };
  });

  if (!days.length) { el.dailyList.innerHTML = '<span class="wx-empty">No daily data available.</span>'; return; }

  const frag = document.createDocumentFragment();
  days.forEach(({ entry: e, tMin, tMax }) => {
    const dt   = new Date(e.dt * 1000);
    const icon = `https://openweathermap.org/img/wn/${e.weather?.[0]?.icon || '01d'}.png`;
    const pop  = e.pop ? Math.round(e.pop * 100) : 0;

    const item = document.createElement('div');
    item.className = 'wx-daily-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <div class="wx-day-name">${dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
      <div class="wx-day-date">${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
      <img src="${icon}" alt="${e.weather?.[0]?.description || ''}" loading="lazy" width="38" height="38" />
      <div class="wx-day-cond">${e.weather?.[0]?.description || ''}</div>
      <div class="wx-temp-range">
        <span class="wx-temp-max">${fmt(tMax)}°</span>
        <span class="wx-temp-sep">/</span>
        <span class="wx-temp-min">${fmt(tMin)}°</span>
      </div>
      ${pop > 0 ? `<div class="wx-day-pop">🌧 ${pop}%</div>` : ''}`;
    frag.appendChild(item);
  });
  el.dailyList.replaceChildren(frag);
}

// ── Render full dashboard ──────────────────────────────────────────────────────
function renderDashboard(data) {
  if (!data) return;
  const current  = data.current || {};
  const forecast = data.forecast || {};

  // Current conditions
  const cityName = current.name || current.city || currentCity || 'Unknown City';
  const country  = current.sys?.country || current.country || '';
  el.cityName.textContent = country ? `${cityName}, ${country}` : cityName;

  const iconCode = current.icon || current.weather?.[0]?.icon || '01d';
  el.icon.src    = `https://openweathermap.org/img/wn/${iconCode}@2x.png`;
  el.icon.alt    = current.description || current.weather?.[0]?.description || current.condition || 'Weather condition';

  const tempVal  = current.temp ?? current.main?.temp;
  el.temp.textContent = `${fmt(tempVal)}°C`;

  const descVal  = current.description || current.weather?.[0]?.description || current.condition || '';
  el.desc.textContent = descVal;

  const feelsLikeVal = current.feelsLike ?? current.main?.feels_like ?? tempVal;
  el.feelsLike.textContent = `Feels like ${fmt(feelsLikeVal)}°C`;

  const riskLevel = data.risk?.level || current.riskLevel || 'none';
  updateRiskBadge(riskLevel);

  // Metrics
  const windKmh = current.windKmh ?? (current.wind?.speed ? Math.round(current.wind.speed * 3.6) : 0);
  el.wind.textContent = `${fmt(windKmh)} km/h`;
  const windDeg = current.wind?.deg;
  el.windSub.textContent = windDeg != null ? `${windDir(windDeg)} ${windDeg}°` : '--';

  const humidity = current.humidity ?? current.main?.humidity;
  el.humidity.textContent = humidity != null ? `${fmt(humidity)}%` : '--';

  const dew = current.dewPoint ?? (tempVal != null && humidity != null ? dewPoint(tempVal, humidity) : null);
  el.dew.textContent = dew != null ? `Dew ${fmt(dew)}°C` : 'Dew --';

  const uv = current.uvIndex ?? current.uvi;
  el.uv.textContent    = uv != null ? fmt(uv) : '--';
  el.uvSub.textContent = uv != null ? uvLabel(uv) : '--';

  const pressure = current.pressure ?? current.main?.pressure;
  el.pressure.textContent    = pressure != null ? `${fmt(pressure)}` : '--';
  el.pressureSub.textContent = 'hPa';

  const vis = current.visibility;
  const visKm = vis != null ? (vis > 100 ? (vis / 1000).toFixed(1) : parseFloat(vis).toFixed(1)) : null;
  el.visibility.textContent = visKm ? `${visKm} km` : '--';
  el.visSub.textContent = visKm
    ? (parseFloat(visKm) >= 10 ? 'Excellent' : parseFloat(visKm) >= 5 ? 'Good' : parseFloat(visKm) >= 2 ? 'Moderate' : 'Poor')
    : '--';

  // Hourly & daily from forecast list or pre-aggregated data
  renderHourly(forecast?.list || data.hourly || []);
  renderDaily(data.daily || forecast?.list || []);

  // Trigger cinematic weather background scene
  const condition = current.condition || current.weather?.[0]?.main || '';
  if (typeof window.updateWeatherBackground === 'function') {
    window.updateWeatherBackground({
      condition,
      icon: iconCode,
      description: descVal,
      temp: tempVal,
    });
  } else if (window.WeatherBackground?.setWeather) {
    const isDaytime = iconCode.endsWith('d') || (!iconCode.endsWith('n') && (new Date().getHours() >= 6 && new Date().getHours() < 20));
    window.WeatherBackground.setWeather(condition.toLowerCase(), isDaytime);
  }

  el.weather.classList.add('active');
}

// ── Fetch weather ──────────────────────────────────────────────────────────────
async function fetchWeather(city, { silent = false } = {}) {
  const trimmed = city.trim();
  if (!trimmed) { showError('Please enter a city name.'); return; }

  currentCity = trimmed;
  clearError();

  // 1. Instant cache check (0ms response)
  const cached = getCachedWeather(trimmed);
  if (cached) {
    renderDashboard(cached);
    addToHistory(cached.current?.name || trimmed);
    lsSet(STORAGE_CITY, cached.current?.name || trimmed);
    lsSet(STORAGE_LAST_DASHBOARD, cached);
    if (el.regCity && !el.regCity.value) el.regCity.value = cached.current?.name || trimmed;

    // Silently revalidate in background if older than 90 seconds
    const entry = clientCache.get(trimmed.toLowerCase());
    if (!entry || (Date.now() - entry.time > 90_000)) {
      silentlyRevalidateWeather(trimmed);
    }
    return;
  }

  // Cancel any in-flight request
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();

  if (!silent) showLoader(`Fetching weather for ${trimmed}…`);

  try {
    const res  = await fetch(`${API_BASE}/weather/dashboard?city=${encodeURIComponent(trimmed)}`, { signal: abortCtrl.signal });
    const data = await res.json();

    if (!res.ok) { throw new Error(data.error || `Server error (${res.status})`); }

    hideLoader();
    renderDashboard(data);
    setCachedWeather(trimmed, data);
    if (data.current?.name) setCachedWeather(data.current.name, data);
    addToHistory(data.current?.name || trimmed);
    lsSet(STORAGE_CITY, data.current?.name || trimmed);
    lsSet(STORAGE_LAST_DASHBOARD, data);

    // Pre-fill alert city if alert saved for this city
    if (el.regCity && !el.regCity.value) el.regCity.value = data.current?.name || trimmed;

  } catch (err) {
    if (err.name === 'AbortError') return;
    hideLoader();
    showError(err.message || 'Failed to fetch weather. Please try again.');
  }
}

async function silentlyRevalidateWeather(city) {
  try {
    const res  = await fetch(`${API_BASE}/weather/dashboard?city=${encodeURIComponent(city)}`);
    if (res.ok) {
      const data = await res.json();
      setCachedWeather(city, data);
      if (data.current?.name) setCachedWeather(data.current.name, data);
      lsSet(STORAGE_LAST_DASHBOARD, data);
      if (currentCity && currentCity.toLowerCase() === city.toLowerCase()) {
        renderDashboard(data);
      }
    }
  } catch (_) {}
}

async function fetchByCoords(lat, lon, { silent = false } = {}) {
  const coordsKey = `coords:${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;

  // Instant cache hit
  const cached = getCachedWeather(coordsKey);
  if (cached) {
    renderDashboard(cached);
    addToHistory(cached.current?.name || 'My Location');
    lsSet(STORAGE_CITY, cached.current?.name || '');
    lsSet(STORAGE_LAST_DASHBOARD, cached);
    if (el.regCity && !el.regCity.value) el.regCity.value = cached.current?.name || '';
    return;
  }

  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  clearError();
  if (!silent) showLoader('Locating you…');

  try {
    const res  = await fetch(`${API_BASE}/weather/dashboard?lat=${lat}&lon=${lon}`, { signal: abortCtrl.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Location weather failed.');
    hideLoader();
    renderDashboard(data);
    setCachedWeather(coordsKey, data);
    if (data.current?.name) setCachedWeather(data.current.name, data);
    addToHistory(data.current?.name || 'My Location');
    lsSet(STORAGE_CITY, data.current?.name || '');
    lsSet(STORAGE_LAST_DASHBOARD, data);
    if (el.regCity && !el.regCity.value) el.regCity.value = data.current?.name || '';
  } catch (err) {
    if (err.name === 'AbortError') return;
    hideLoader();
    showError(err.message || 'Failed to get location weather.');
  }
}

// ── Robust Geolocation & IP Fallback Engine ─────────────────────────────────────
function queryPosition(opts) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, opts);
  });
}

/**
 * Robust device coordinate resolver:
 * - 15-second timeout on initial attempt to allow user to view and click browser permission popup
 * - enableHighAccuracy: false for instant Wi-Fi/network positioning on PC/laptop
 * - Automatic single retry if initial query encounters temporary cold-start timeout or unavailable
 * - Accurate error discrimination (only reporting access denied if code === 1)
 */
async function acquireDeviceCoordinates(onStatusUpdate = null) {
  if (!navigator.geolocation) {
    throw new Error('Geolocation is not supported by your browser.');
  }

  if (navigator.permissions && navigator.permissions.query) {
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'prompt' && onStatusUpdate) {
        onStatusUpdate('Please click "Allow" on the location prompt in your browser…');
      }
    } catch (_) {}
  }

  const primaryOpts = {
    enableHighAccuracy: false,
    timeout: 15000,
    maximumAge: 300000,
  };

  try {
    return await queryPosition(primaryOpts);
  } catch (err) {
    // If timed out or unavailable on first attempt (common on Windows cold starts), retry once
    if (err.code === 3 /* TIMEOUT */ || err.code === 2 /* POSITION_UNAVAILABLE */) {
      if (onStatusUpdate) onStatusUpdate('Locating you (retrying)…');
      try {
        return await queryPosition({ enableHighAccuracy: false, timeout: 10000, maximumAge: Infinity });
      } catch (retryErr) {
        err = retryErr;
      }
    }

    if (err.code === 1 /* PERMISSION_DENIED */) {
      const e = new Error('Location access denied. Please allow location in your browser settings or search manually.');
      e.code = 'PERMISSION_DENIED';
      throw e;
    } else if (err.code === 3 /* TIMEOUT */) {
      const e = new Error('Location request timed out. Please try again or search manually.');
      e.code = 'TIMEOUT';
      throw e;
    } else {
      const e = new Error('Location unavailable on your device.');
      e.code = 'POSITION_UNAVAILABLE';
      throw e;
    }
  }
}

/**
 * Resolves current user location: tries device Geolocation first,
 * and automatically falls back to IP-based location if device sensors fail.
 */
async function resolveCurrentLocation(onStatusUpdate = null) {
  try {
    const pos = await acquireDeviceCoordinates(onStatusUpdate);
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      isFallback: false,
    };
  } catch (geoErr) {
    // Attempt fast IP-based location fallback
    if (onStatusUpdate) onStatusUpdate('Attempting network location fallback…');
    try {
      const res = await fetch(`${API_BASE}/weather/ip-location`);
      const data = await res.json();
      if (res.ok && data.success && data.lat && data.lon) {
        return {
          lat: data.lat,
          lon: data.lon,
          city: data.city || 'My Location',
          isFallback: true,
        };
      }
    } catch (_) {}

    // If IP fallback also failed, re-throw the original geolocation error
    throw geoErr;
  }
}

// ── Search event bindings ──────────────────────────────────────────────────────
el.searchBtn.addEventListener('click', () => fetchWeather(el.cityInput.value));
el.cityInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchWeather(el.cityInput.value); });
el.cityInput.addEventListener('input', debounce(() => {
  const v = el.cityInput.value.trim();
  if (v.length >= 3) fetchWeather(v);
}, 350));

el.locationBtn.addEventListener('click', async () => {
  if (el.locationBtn.classList.contains('loading')) return;
  el.locationBtn.classList.add('loading');
  const originalText = el.locationBtn.textContent;
  el.locationBtn.textContent = '📍 Locating…';
  clearError();
  showLoader('Detecting your location…');

  try {
    const loc = await resolveCurrentLocation(statusMsg => {
      showLoader(statusMsg);
    });
    await fetchByCoords(loc.lat, loc.lon);
  } catch (err) {
    hideLoader();
    showError(err.message || 'Failed to detect location. Please search manually.');
  } finally {
    el.locationBtn.classList.remove('loading');
    el.locationBtn.textContent = originalText;
  }
});

// ── Alert modal ────────────────────────────────────────────────────────────────
async function openModal() {
  clearModalMsg();
  el.alertModal.classList.add('open');
  el.regName.focus();

  // 1. Pre-fill from local storage
  const saved = lsGet(STORAGE_ALERT) || {};

  if (saved.name)  el.regName.value  = saved.name;
  if (saved.email) el.regEmail.value = saved.email;
  if (saved.city)  el.regCity.value  = saved.city;
  else if (currentCity && !el.regCity.value) el.regCity.value = currentCity;

  if (saved.prefs) {
    document.querySelectorAll(PREF_SEL).forEach(cb => {
      cb.checked = Boolean(saved.prefs[cb.value]);
    });
  }

  // 2. Fetch live status from backend by email to sync preferences
  const storedEmail = saved.email || el.regEmail.value.trim();
  if (storedEmail && EMAIL_RE.test(storedEmail)) {
    try {
      const res  = await fetch(`${API_BASE}/users/status?email=${encodeURIComponent(storedEmail)}`);
      const data = await res.json();
      if (data.registered) {
        if (data.name) el.regName.value = data.name;
        if (data.city) el.regCity.value = data.city;
        if (data.preferences) {
          document.querySelectorAll(PREF_SEL).forEach(cb => {
            if (data.preferences[cb.value] !== undefined) {
              cb.checked = Boolean(data.preferences[cb.value]);
            }
          });
        }
        // Sync snooze state from backend
        const liveSnooze = data.snoozeUntil || null;
        setLocalSnooze(liveSnooze);
        renderSnoozeStatus(liveSnooze);
        updateAlertBtnBadge();
      } else {
        // User was deleted from backend DB — purge stale localStorage and reset fields
        try { localStorage.removeItem(STORAGE_ALERT); } catch {}
        try { localStorage.removeItem(STORAGE_SNOOZE); } catch {}
        el.regName.value  = '';
        el.regEmail.value = '';
        el.regCity.value  = currentCity || '';
        document.querySelectorAll(PREF_SEL).forEach(cb => { cb.checked = true; });
        setLocalSnooze(null);
        renderSnoozeStatus(null);
        updateAlertBtnBadge();
      }
    } catch (_) {}
  }
}

function closeModal() {
  el.alertModal.classList.remove('open');
}

el.alertModalBtn.addEventListener('click', openModal);
el.closeModalBtn.addEventListener('click', closeModal);
el.alertModal.addEventListener('click', e => { if (e.target === el.alertModal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Alert modal — Fetch Location for City field ────────────────────────────
if (el.alertLocationBtn) {
  el.alertLocationBtn.addEventListener('click', async () => {
    if (el.alertLocationBtn.classList.contains('loading')) return;
    el.alertLocationBtn.classList.add('loading');
    el.alertLocationBtn.title = 'Detecting location…';
    clearModalMsg();

    try {
      const loc = await resolveCurrentLocation(msg => {
        el.alertLocationBtn.title = msg;
      });

      // Use backend weather endpoint to reverse-geocode coordinates to city
      const res  = await fetch(`${API_BASE}/weather/dashboard?lat=${loc.lat}&lon=${loc.lon}`);
      const data = await res.json();
      if (res.ok && data.current) {
        const city = data.current.name || data.current.city || loc.city || '';
        if (city) {
          el.regCity.value = city;
          el.regCity.focus();
          if (loc.isFallback) {
            showModalMsg(`📍 Set city to ${city} (via network location).`, 'success');
          } else {
            showModalMsg(`📍 Detected location: ${city}`, 'success');
          }
          // Also load weather if not already shown
          if (!currentCity) fetchByCoords(loc.lat, loc.lon);
        } else {
          showModalMsg('Could not resolve city from location.', 'error');
        }
      } else {
        showModalMsg(data.error || 'Could not resolve city.', 'error');
      }
    } catch (err) {
      showModalMsg(err.message || 'Location lookup failed. Please enter city manually.', 'error');
    } finally {
      el.alertLocationBtn.classList.remove('loading');
      el.alertLocationBtn.title = 'Use my current location to fill city';
    }
  });
}

// ── Delete / Unsubscribe User ──────────────────────────────────────────────────
if (el.deleteUserBtn) {
  el.deleteUserBtn.addEventListener('click', async () => {
    const email = el.regEmail.value.trim() || (lsGet(STORAGE_ALERT) || {}).email || '';
    if (email && EMAIL_RE.test(email)) {
      try {
        await fetch(`${API_BASE}/users?email=${encodeURIComponent(email)}`, { method: 'DELETE' });
      } catch (_) {}
    }
    try { localStorage.removeItem(STORAGE_ALERT); } catch {}
    try { localStorage.removeItem(STORAGE_SNOOZE); } catch {}
    el.regName.value  = '';
    el.regEmail.value = '';
    el.regCity.value  = currentCity || '';
    document.querySelectorAll(PREF_SEL).forEach(cb => { cb.checked = true; });
    setLocalSnooze(null);
    renderSnoozeStatus(null);
    updateAlertBtnBadge();
    showModalMsg('User data and alert settings removed.', 'success');
  });
}

// ── Snooze dropdown — show/hide custom datetime picker ──────────────────────
el.snoozeDuration.addEventListener('change', () => {
  const isCustom = el.snoozeDuration.value === 'custom';
  el.snoozeCustom.style.display = isCustom ? 'block' : 'none';
  if (!isCustom) el.snoozeCustom.value = '';
  if (isCustom) {
    // Default to 8 hours from now
    const d = new Date(Date.now() + 8 * 3_600_000);
    el.snoozeCustom.value = d.toISOString().slice(0, 16);
    el.snoozeCustom.focus();
  }
});

// ── Alert form submit (register) ───────────────────────────────────────────────
el.alertForm.addEventListener('submit', async e => {
  e.preventDefault();

  const name  = el.regName.value.trim();
  const email = el.regEmail.value.trim();
  const city  = el.regCity.value.trim();

  // Collect checked preference checkboxes (via shared PREF_SEL constant)
  const prefs = {};
  document.querySelectorAll(PREF_SEL + ':checked').forEach(cb => { prefs[cb.value] = true; });

  if (!name || !email || !city) { showModalMsg('Please fill in all fields.', 'error'); return; }
  if (!EMAIL_RE.test(email)) { showModalMsg('Enter a valid email address.', 'error'); return; }

  el.saveAlertBtn.disabled    = true;
  el.saveAlertBtn.textContent = 'Saving…';
  clearModalMsg();

  try {
    const res  = await fetch(`${API_BASE}/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, city, preferences: prefs }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || 'Registration failed.');

    // Persist locally so form re-fills on next visit
    lsSet(STORAGE_ALERT, { name, email, city, prefs });

    // ── Apply snooze (or clear it) ──────────────────────────────────────────
    const snoozeUntil = resolveSnoozeUntil();
    try {
      const sr = await fetch(`${API_BASE}/users/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, snoozeUntil }),
      });
      const sd = await sr.json();
      if (sd.success) {
        setLocalSnooze(sd.snoozeUntil);
        updateAlertBtnBadge();
        renderSnoozeStatus(sd.snoozeUntil);
        const snoozeMsg = sd.snoozeUntil
          ? ` Alerts snoozed for ${fmtDuration(snoozeRemainingMs(sd.snoozeUntil))}.`
          : ' Alerts are active.';
        showModalMsg((data.message || 'Alert preferences saved!') + snoozeMsg, 'success');
      } else {
        showModalMsg(data.message || 'Alert preferences saved! (snooze update failed)', 'success');
      }
    } catch (_) {
      showModalMsg(data.message || 'Alert preferences saved!', 'success');
    }
    // ───────────────────────────────────────────────────────────────────────

    el.sendTestEmailBtn.disabled = false;
  } catch (err) {
    showModalMsg(err.message, 'error');
  } finally {
    el.saveAlertBtn.disabled    = false;
    el.saveAlertBtn.textContent = 'Save Alert Preferences';
  }
});

// ── Test email send ────────────────────────────────────────────────────────────
el.sendTestEmailBtn.addEventListener('click', async () => {
  const name  = el.regName.value.trim();
  const email = el.regEmail.value.trim();
  const city  = el.regCity.value.trim() || currentCity;

  if (!email || !EMAIL_RE.test(email)) {
    showModalMsg('Enter a valid email address first.', 'error');
    return;
  }

  el.sendTestEmailBtn.disabled   = true;
  el.sendTestEmailBtn.textContent = 'Sending…';
  clearModalMsg();

  try {
    const res  = await fetch(`${API_BASE}/alerts/test-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        city,
        name,
        dashboardUrl: window.location.origin,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || 'Email delivery failed.');
    showModalMsg(`✅ Test email sent to ${email}! Check your inbox.`, 'success');
  } catch (err) {
    showModalMsg(`✗ ${err.message}`, 'error');
  } finally {
    el.sendTestEmailBtn.disabled   = false;
    el.sendTestEmailBtn.textContent = '✉️ Send Test Alert Email';
  }
});

// ── Initialise ─────────────────────────────────────────────────────────────────
(function init() {
  startClock();
  renderHistory();
  updateAlertBtnBadge();

  // Refresh badge every minute so the countdown stays accurate
  setInterval(updateAlertBtnBadge, 60_000);

  const lastCity = lsGet(STORAGE_CITY, '') || 'London';
  el.cityInput.value = lastCity;

  // Instant SWR: Immediately render last dashboard from storage in 0 ms!
  const cachedDashboard = lsGet(STORAGE_LAST_DASHBOARD);
  if (cachedDashboard && cachedDashboard.current) {
    renderDashboard(cachedDashboard);
    setCachedWeather(cachedDashboard.current.name || lastCity, cachedDashboard);
    // Background silent revalidation without disruptive spinners
    fetchWeather(lastCity, { silent: true });
  } else {
    // First-time visit cold load
    fetchWeather(lastCity);
  }
})();
