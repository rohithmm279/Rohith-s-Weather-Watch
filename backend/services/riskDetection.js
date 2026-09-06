'use strict';

// Note: dotenv is loaded by server.js at startup — process.env is already populated.

const THRESHOLDS = {
  rainProbability: parseFloat(process.env.RISK_RAIN_PROBABILITY) || 70, // %
  highTemperature: parseFloat(process.env.RISK_HIGH_TEMPERATURE) || 40, // °C
  strongWind:      parseFloat(process.env.RISK_STRONG_WIND)      || 50, // km/h
};

function msToKmh(ms) {
  return ms * 3.6;
}

function detectRisks(forecastData) {
  if (!forecastData || !Array.isArray(forecastData.list)) return [];

  const next24h = forecastData.list.slice(0, 8); // 8 × 3h = 24 hours
  const risks   = [];
  const seen    = new Set();

  for (const period of next24h) {
    const pop          = (period.pop || 0) * 100;
    const temp         = period.main ? period.main.temp : 0;
    const windKmh      = period.wind ? msToKmh(period.wind.speed) : 0;
    const condition    = period.weather && period.weather[0] ? period.weather[0].main : '';
    const forecastTime = period.dt_txt || '';

    // Thunderstorm
    if (!seen.has('thunder') && condition === 'Thunderstorm') {
      risks.push({
        type: 'thunder',
        severity: 'severe',
        message: `Thunderstorm predicted around ${forecastTime}`,
        value: condition,
        forecastTime,
      });
      seen.add('thunder');
    }

    // Heavy rain
    if (!seen.has('rain') && pop >= THRESHOLDS.rainProbability) {
      const severity = pop >= 85 ? 'severe' : 'moderate';
      risks.push({
        type: 'rain',
        severity,
        message: `Heavy rainfall likely (${Math.round(pop)}% probability)`,
        value: Math.round(pop),
        forecastTime,
      });
      seen.add('rain');
    }

    // High temperature
    if (!seen.has('heat') && temp >= THRESHOLDS.highTemperature) {
      risks.push({
        type: 'heat',
        severity: 'moderate',
        message: `High temperature predicted: ${temp.toFixed(1)}°C`,
        value: parseFloat(temp.toFixed(1)),
        forecastTime,
      });
      seen.add('heat');
    }

    // Strong wind (km/h)
    if (!seen.has('wind') && windKmh >= THRESHOLDS.strongWind) {
      risks.push({
        type: 'wind',
        severity: 'moderate',
        message: `Strong winds predicted: ${windKmh.toFixed(1)} km/h`,
        value: parseFloat(windKmh.toFixed(1)),
        forecastTime,
      });
      seen.add('wind');
    }
  }

  return risks;
}

function getOverallRiskLevel(risks) {
  if (!risks || risks.length === 0) return 'none';
  if (risks.some(r => r.severity === 'severe') || risks.length >= 3) return 'severe';
  if (risks.length >= 2) return 'high';
  if (risks.some(r => r.type === 'heat' || r.type === 'wind')) return 'moderate';
  return 'low';
}

module.exports = { detectRisks, getOverallRiskLevel, msToKmh, THRESHOLDS };
