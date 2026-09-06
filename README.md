#<img width="1024" height="1024" alt="image" src="https://github.com/user-attachments/assets/325411b7-6b19-4b96-b505-f220bf57efb0" />
Rohith's WeatherWatch — 24/7 Automated Weather Monitoring System

> **Register once. Close the page. Get alerted via email when dangerous weather approaches your city.**

---

## 📌 Project Objective

WeatherWatch is a full-stack weather monitoring and early-warning system that checks forecast data automatically and sends personalized HTML email alerts via Brevo when risky conditions (heavy rain, extreme heat, strong winds, thunderstorms) are predicted.

The core workflow:

```
User registers → Saves city & alert preferences → Closes website
         ↓
  Backend monitors automatically every 30 minutes (configurable)
         ↓
  Weather forecast fetched for each registered city (deduplicated & cached)
         ↓
  Risks detected using configurable meteorological thresholds
         ↓
  Relevant users identified → 3-hour cooldown prevents duplicates
         ↓
  Rich HTML alert email sent via Brevo API
         ↓
  Monitoring continues 24/7
```

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Weather Dashboard** | Search any city or use GPS location with instant response |
| **Current Conditions** | Temperature, humidity, wind speed (km/h), dew point, UV index, visibility |
| **Risk Status Badge** | 🟢 Clear · 🟡 Low · 🟠 Moderate · 🔴 High · 🚨 Severe real-time badges |
| **Hourly & 5-Day Forecasts** | 24-hour hourly strip with rain probability and 5-day daily outlook |
| **Email Alert Registration** | Register name, email, city, and specific weather alert categories |
| **24/7 Background Scheduler** | Automated monitoring via `node-cron` with zero frontend dependency |
| **Duplicate Prevention** | Configurable cooldown window (`ALERT_COOLDOWN_MINUTES`) prevents spam |
| **Brevo Email Integration** | Production-ready transactional email delivery with responsive HTML templates |
| **Cinematic Canvas Engine** | 24 dynamic sky palettes (day/dawn/dusk/night x 6 conditions) with particle layers |
| **Search History** | Remembers recently searched cities in local storage |

---

## 🏗 System Architecture

```
Weather-Monitoring-app/
├── frontend/
│   ├── index.html          ← Bento Grid UI & Email Alert Modal
│   ├── main.css            ← Glassmorphism & responsive layout styles
│   └── JS/
│       ├── main.js         ← Frontend logic, API integration, and rendering
│       └── weatherBackground.js ← Cinematic 2D Canvas Weather Engine
│
├── backend/
│   ├── server.js           ← Express app, static server, and admin endpoints
│   ├── routes/
│   │   ├── weather.js      ← Weather & dashboard proxy with caching
│   │   └── users.js        ← User registration and email status
│   ├── services/
│   │   ├── weatherService.js ← OpenWeatherMap API client with 10-min cache
│   │   ├── riskDetection.js  ← Rule-based meteorological risk engine
│   │   └── emailService.js   ← Brevo v3 REST API email dispatcher
│   ├── scheduler/
│   │   └── monitorJob.js     ← node-cron scheduler & city deduplication
│   └── database/
│       ├── db.js             ← SQLite connection (built-in node:sqlite)
│       └── weather.db        ← Persistent database file
│
├── .env                    ← Environment credentials (never commit)
├── .env.example            ← Template for environment variables
├── package.json
└── README.md
```

**Tech Stack:**
- **Frontend:** HTML5, CSS3 (Vanilla Glassmorphism), Vanilla JavaScript
- **Backend:** Node.js 22+, Express
- **Database:** SQLite (native `node:sqlite` — zero setup, zero native compilation)
- **Scheduler:** `node-cron`
- **Weather API:** OpenWeatherMap
- **Email Service:** Brevo (formerly Sendinblue) Transactional Email API

---

## ⚙️ Installation

### Prerequisites
- Node.js **18 or higher** (native `fetch` and `node:sqlite` required)
- An OpenWeatherMap API key: https://openweathermap.org/appid
- A Brevo API key: https://app.brevo.com/

### Steps

```bash
# 1. Clone or download the project
cd Weather-Monitoring-app

# 2. Install dependencies
npm install

# 3. Set up environment variables
copy .env.example .env
# (Linux/macOS: cp .env.example .env)
```

Open `.env` and fill in your values:

```env
WEATHER_API_KEY=your_openweathermap_api_key_here
PORT=3000
WEATHER_CACHE_TTL_MINUTES=10
WEATHER_CHECK_INTERVAL=30
ALERT_COOLDOWN_MINUTES=180
RISK_RAIN_PROBABILITY=70
RISK_HIGH_TEMPERATURE=40
RISK_STRONG_WIND=50

# Brevo Email Configuration
BREVO_API_KEY=your_brevo_v3_api_key_here
BREVO_SENDER_EMAIL=your_verified_sender@example.com
BREVO_SENDER_NAME=Weather Alert
ALERT_RECIPIENT_EMAIL=your_email@example.com
```

---

## 🚀 Running the App

```bash
npm run dev
# or:
npm start
```

Open your browser: **http://localhost:3000**

- The backend serves the frontend automatically.
- The monitoring scheduler starts immediately in the background.

---

## 🔄 How Automated Monitoring Works

1. **Startup** — The scheduler activates when the backend process starts.
2. **Every N minutes** — Configurable interval via `WEATHER_CHECK_INTERVAL` (default: 30 mins).
3. **Per unique city** — Cities are queried from SQLite. Forecast is fetched **once per city** regardless of how many users are registered there.
4. **Forecast cache** — OpenWeatherMap responses are cached in memory to minimize API usage.
5. **Risk detection** — Evaluates rain probability, temperatures, wind speeds, and thunderstorms over the next 24 hours.
6. **User matching** — Identifies registered users for that city whose preferences match detected risks.
7. **Cooldown check** — Checks `alert_history` to prevent sending duplicate emails within `ALERT_COOLDOWN_MINUTES` (default: 3 hours).
8. **Email dispatch** — Sends responsive, styled HTML alert emails via Brevo with safety guidelines.

---

## ✉️ Email Alert Testing

### 1. Send a Test Alert Email from the UI
1. Click the **🔔 Alerts** button in the dashboard header.
2. Enter your Name, Email, and City.
3. Click **✉️ Send Test Alert Email** to verify delivery directly to your inbox.

### 2. Trigger an Immediate Monitoring Cycle
Trigger an instant monitoring run without waiting for the cron timer:

```bash
# PowerShell:
Invoke-RestMethod -Uri "http://localhost:3000/api/admin/trigger-monitor" -Method Post

# Linux / Mac:
curl -X POST http://localhost:3000/api/admin/trigger-monitor
```

---

## 🌡️ Risk Thresholds (configurable via `.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `RISK_RAIN_PROBABILITY` | 70 | Rain probability % to trigger rain alert |
| `RISK_HIGH_TEMPERATURE` | 40 | Temperature °C to trigger heat alert |
| `RISK_STRONG_WIND` | 50 | Wind speed km/h to trigger wind alert |

Thunderstorms are detected directly from meteorological weather codes regardless of numeric thresholds.

---

## 📋 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/weather/dashboard?city=` | Unified current weather, hourly & 5-day forecasts, and risk level |
| `GET` | `/api/weather/dashboard?lat=&lon=` | Weather by coordinates |
| `POST` | `/api/users/register` | Register or update user email alert preferences |
| `GET` | `/api/users/status?email=` | Pre-fill user registration preferences by email |
| `POST` | `/api/alerts/test-email` | Send a one-off test alert email via Brevo |
| `POST` | `/api/admin/trigger-monitor` | Manually run a monitoring cycle |
| `GET` | `/api/health` | Service health status and Brevo connection state |
