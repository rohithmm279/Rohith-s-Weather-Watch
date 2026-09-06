// ============================================================
// weatherBackground.js — Cinematic Weather Engine v2
// ============================================================
// Layered Cinematic Environment Pipeline:
//   Frame Render Order (Back → Front):
//     1. Sky Layer        — HDR-style 4-stop gradient sky with atmosphere depth
//     2. Star/Moon Layer  — Night: twinkling star field + crescent moon
//     3. Lighting Layer   — Sun disc, atmospheric god-rays, horizon glow, storm vignette
//     4. Cloud Layer      — 3-depth procedural volumetric clouds (5-7 ellipses each)
//     5. Particle Layer   — Depth-split rain / 4-class snow / golden sun motes
//     6. Atmosphere Layer — Fog bands, ground mist, color grading overlay
//
// Features:
//   - 24 distinct sky palettes (day/dawn/dusk/night x 6 weather conditions)
//   - Smooth 4-second RGB stop-by-stop color interpolation on transition
//   - Volumetric procedural clouds with zenith highlights and dark underside
//   - High/Ultra god rays with rotational drift and pulsating storm vignette
//   - Auto-detected performance tiers (ULTRA, HIGH, MEDIUM, LOW)
//   - Visibility change detection (pauses on hidden tab, resumes on return)
//   - Responsive canvas with resize handler
//
// Public API:
//   updateWeatherBackground({ condition, icon, description, temp })
//   updateWeatherBackground("Clear")  ← legacy string form
// ============================================================

(function (global) {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // 1. CONDITION & TIME-OF-DAY NORMALIZATION
  // ─────────────────────────────────────────────────────────────
  const CONDITION_MAP = {
    thunderstorm: "storm",
    squall: "storm",
    tornado: "storm",
    drizzle: "rain",
    rain: "rain",
    snow: "snow",
    mist: "fog",
    smoke: "fog",
    haze: "fog",
    dust: "fog",
    fog: "fog",
    sand: "fog",
    ash: "fog",
    clear: "clear",
    sunny: "clear",
    clouds: "cloudy",
  };

  function normalizeCondition(raw) {
    const key = (raw || "").toLowerCase().trim();
    return CONDITION_MAP[key] || "default";
  }

  function isNightIcon(icon) {
    return Boolean(icon && icon.endsWith("n"));
  }

  function getTimeOfDay(icon) {
    // If icon explicitly indicates night ('n'), default to night
    const h = new Date().getHours();
    if (isNightIcon(icon)) {
      // Early morning before 6:30 or late evening can still have twilight feel if within bounds
      if (h >= 5 && h < 7) return "dawn";
      return "night";
    }
    // Daytime icon ('d') or no icon
    if (h >= 5 && h < 7) return "dawn";
    if (h >= 17 && h < 20) return "dusk";
    if (h < 5 || h >= 20) return "night";
    return "day";
  }

  // ─────────────────────────────────────────────────────────────
  // 2. PERFORMANCE MANAGER
  // ─────────────────────────────────────────────────────────────
  const Perf = (() => {
    const cores = navigator.hardwareConcurrency || 2;
    const isMobile = window.innerWidth <= 768;
    const reducedMotion = Boolean(
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );

    let tier;
    if (reducedMotion) {
      tier = "LOW";
    } else if (cores >= 8 && !isMobile) {
      tier = "ULTRA";
    } else if (cores >= 4 && !isMobile) {
      tier = "HIGH";
    } else if (cores >= 2 || isMobile) {
      tier = "MEDIUM";
    } else {
      tier = "LOW";
    }

    const SCALE = {
      ULTRA: 1.0,
      HIGH: 0.72,
      MEDIUM: 0.5,
      LOW: 0.28,
    };

    return {
      tier,
      scale: SCALE[tier] || 0.5,
      reducedMotion,
      isMobile,
      count: (n) => Math.max(2, Math.round(n * (SCALE[tier] || 0.5))),
    };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. MATH & COLOR UTILITIES
  // ─────────────────────────────────────────────────────────────
  function rand(a, b) {
    return Math.random() * (b - a) + a;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function smoothstep(t) {
    const c = clamp(t, 0, 1);
    return c * c * (3 - 2 * c);
  }

  function parseHexOrRgb(colorStr) {
    if (colorStr.startsWith("#")) {
      let hex = colorStr.slice(1);
      if (hex.length === 3) {
        hex = hex.split("").map((c) => c + c).join("");
      }
      const num = parseInt(hex, 16);
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return [+match[1], +match[2], +match[3]];
    }
    return [100, 140, 180];
  }

  function lerpColor(c1, c2, t) {
    const rgb1 = typeof c1 === "string" ? parseHexOrRgb(c1) : c1;
    const rgb2 = typeof c2 === "string" ? parseHexOrRgb(c2) : c2;
    const r = Math.round(lerp(rgb1[0], rgb2[0], t));
    const g = Math.round(lerp(rgb1[1], rgb2[1], t));
    const b = Math.round(lerp(rgb1[2], rgb2[2], t));
    return `rgb(${r},${g},${b})`;
  }

  function lerpPalette(p1, p2, t) {
    const stops = [];
    const len = Math.min(p1.length, p2.length);
    for (let i = 0; i < len; i++) {
      stops.push(lerpColor(p1[i], p2[i], t));
    }
    return stops;
  }

  // ─────────────────────────────────────────────────────────────
  // 4. SKY PALETTES (24 Full Palettes: 6 Conditions × 4 Times)
  // ─────────────────────────────────────────────────────────────
  const SkyPalettes = {
    // Clear / Sunny
    clear_day:   ["#1872c4", "#3d9be9", "#78c3f5", "#c8ebff"],
    clear_dawn:  ["#1b2845", "#4a3f6b", "#c26257", "#fed197"],
    clear_dusk:  ["#151c38", "#5d2b56", "#d95a32", "#f6c374"],
    clear_night: ["#020614", "#08142b", "#0e2246", "#173059"],

    // Cloudy
    cloudy_day:   ["#4b5768", "#718294", "#9eb2c2", "#c7d7e3"],
    cloudy_dawn:  ["#252c38", "#4b3f52", "#8c636f", "#c9a19c"],
    cloudy_dusk:  ["#1f2430", "#4a354b", "#7e4f55", "#b88277"],
    cloudy_night: ["#0a0f16", "#151d27", "#222f3e", "#314255"],

    // Rain
    rain_day:   ["#233140", "#344b5e", "#4c6880", "#6b89a1"],
    rain_dawn:  ["#1a2430", "#343042", "#58495a", "#857582"],
    rain_dusk:  ["#161e29", "#322838", "#543e49", "#7d6168"],
    rain_night: ["#090d13", "#111822", "#1a2533", "#253447"],

    // Storm
    storm_day:   ["#0c1017", "#17202c", "#223040", "#304255"],
    storm_dawn:  ["#0d1118", "#1a1826", "#302633", "#493945"],
    storm_dusk:  ["#0b0e14", "#191522", "#2d202c", "#422f3b"],
    storm_night: ["#05070a", "#0a0e14", "#101720", "#182230"],

    // Fog
    fog_day:   ["#7d8d9b", "#9cb0bf", "#bed0dd", "#dde8ef"],
    fog_dawn:  ["#3b3c48", "#5c5462", "#877685", "#bda8af"],
    fog_dusk:  ["#343542", "#594d57", "#806870", "#af9698"],
    fog_night: ["#161c24", "#222c37", "#303d4c", "#405060"],

    // Snow
    snow_day:   ["#a8c7e2", "#c5ddf0", "#dff0fa", "#f2f8fc"],
    snow_dawn:  ["#2e344a", "#544d68", "#937388", "#d6b8c4"],
    snow_dusk:  ["#252a3d", "#52435e", "#8c5e6f", "#c99ca8"],
    snow_night: ["#0b121e", "#152033", "#20304d", "#2d4268"],

    // Fallback defaults
    default_day:   ["#1f68aa", "#3b92dc", "#67b7ed", "#bde2f8"],
    default_dawn:  ["#202b48", "#563859", "#b35b4a", "#f0be82"],
    default_dusk:  ["#18233c", "#602c52", "#c9643b", "#f5be7a"],
    default_night: ["#030712", "#0a1628", "#142544", "#1f355c"],
    default:       ["#2b6cb0", "#4299e1", "#63b3ed", "#bee3f8"],
  };

  // Body CSS background gradients corresponding to palettes
  const BODY_GRADIENTS = {
    clear_day:   "linear-gradient(170deg, #1872c4 0%, #3d9be9 45%, #78c3f5 85%, #c8ebff 100%)",
    clear_dawn:  "linear-gradient(170deg, #1b2845 0%, #4a3f6b 40%, #c26257 75%, #fed197 100%)",
    clear_dusk:  "linear-gradient(170deg, #151c38 0%, #5d2b56 38%, #d95a32 72%, #f6c374 100%)",
    clear_night: "linear-gradient(170deg, #020614 0%, #08142b 45%, #0e2246 80%, #173059 100%)",

    cloudy_day:   "linear-gradient(170deg, #4b5768 0%, #718294 45%, #9eb2c2 80%, #c7d7e3 100%)",
    cloudy_dawn:  "linear-gradient(170deg, #252c38 0%, #4b3f52 45%, #8c636f 80%, #c9a19c 100%)",
    cloudy_dusk:  "linear-gradient(170deg, #1f2430 0%, #4a354b 45%, #7e4f55 80%, #b88277 100%)",
    cloudy_night: "linear-gradient(170deg, #0a0f16 0%, #151d27 45%, #222f3e 80%, #314255 100%)",

    rain_day:   "linear-gradient(170deg, #233140 0%, #344b5e 45%, #4c6880 80%, #6b89a1 100%)",
    rain_dawn:  "linear-gradient(170deg, #1a2430 0%, #343042 45%, #58495a 80%, #857582 100%)",
    rain_dusk:  "linear-gradient(170deg, #161e29 0%, #322838 45%, #543e49 80%, #7d6168 100%)",
    rain_night: "linear-gradient(170deg, #090d13 0%, #111822 45%, #1a2533 80%, #253447 100%)",

    storm_day:   "linear-gradient(170deg, #0c1017 0%, #17202c 45%, #223040 80%, #304255 100%)",
    storm_dawn:  "linear-gradient(170deg, #0d1118 0%, #1a1826 45%, #302633 80%, #493945 100%)",
    storm_dusk:  "linear-gradient(170deg, #0b0e14 0%, #191522 45%, #2d202c 80%, #422f3b 100%)",
    storm_night: "linear-gradient(170deg, #05070a 0%, #0a0e14 45%, #101720 80%, #182230 100%)",

    fog_day:   "linear-gradient(170deg, #7d8d9b 0%, #9cb0bf 45%, #bed0dd 80%, #dde8ef 100%)",
    fog_dawn:  "linear-gradient(170deg, #3b3c48 0%, #5c5462 45%, #877685 80%, #bda8af 100%)",
    fog_dusk:  "linear-gradient(170deg, #343542 0%, #594d57 45%, #806870 80%, #af9698 100%)",
    fog_night: "linear-gradient(170deg, #161c24 0%, #222c37 45%, #303d4c 80%, #405060 100%)",

    snow_day:   "linear-gradient(170deg, #a8c7e2 0%, #c5ddf0 45%, #dff0fa 80%, #f2f8fc 100%)",
    snow_dawn:  "linear-gradient(170deg, #2e344a 0%, #544d68 45%, #937388 80%, #d6b8c4 100%)",
    snow_dusk:  "linear-gradient(170deg, #252a3d 0%, #52435e 45%, #8c5e6f 80%, #c99ca8 100%)",
    snow_night: "linear-gradient(170deg, #0b121e 0%, #152033 45%, #20304d 80%, #2d4268 100%)",

    default: "linear-gradient(170deg, #2b6cb0 0%, #4299e1 55%, #63b3ed 100%)",
  };

  function resolveSceneKey(type, icon) {
    const timeOfDay = getTimeOfDay(icon);
    const candidate = `${type}_${timeOfDay}`;
    if (SkyPalettes[candidate]) return candidate;
    if (SkyPalettes[`${type}_day`]) return `${type}_day`;
    return `default_${timeOfDay}` in SkyPalettes ? `default_${timeOfDay}` : "default";
  }

  function applyBodyGradient(sceneKey) {
    const grad = BODY_GRADIENTS[sceneKey] || BODY_GRADIENTS.default;
    document.body.style.background = grad;
  }

  // ─────────────────────────────────────────────────────────────
  // 5. LAYER 1: SKY LAYER
  // ─────────────────────────────────────────────────────────────
  function drawSky(ctx, W, H, stops) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    const n = stops.length;
    for (let i = 0; i < n; i++) {
      grad.addColorStop(i / (n - 1), stops[i]);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // ─────────────────────────────────────────────────────────────
  // 6. LAYER 2: STAR & MOON LAYER (Night)
  // ─────────────────────────────────────────────────────────────
  function buildStars(W, H) {
    const count = Perf.count(160);
    return Array.from({ length: count }, () => ({
      x: rand(0, W),
      y: rand(0, H * 0.72),
      r: rand(0.4, 1.4),
      alpha: rand(0.35, 0.95),
      twinkleSpeed: rand(0.008, 0.028),
      twinklePhase: rand(0, Math.PI * 2),
    }));
  }

  function drawStars(ctx, stars, t, globalAlpha) {
    if (!stars || stars.length === 0) return;
    stars.forEach((s) => {
      const a = s.alpha * (0.6 + 0.4 * Math.sin(t * s.twinkleSpeed * 60 + s.twinklePhase)) * globalAlpha;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,245,${clamp(a, 0, 1)})`;
      ctx.fill();
    });
  }

  function drawMoon(ctx, W, H, t, globalAlpha) {
    const cx = W * 0.78;
    const cy = H * 0.15;
    const r = Math.min(W, H) * 0.042;

    ctx.save();
    ctx.globalAlpha = globalAlpha;

    // Atmospheric cool blue halo glow
    const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 3.8);
    glow.addColorStop(0, "rgba(200,225,255,0.18)");
    glow.addColorStop(0.5, "rgba(170,205,255,0.06)");
    glow.addColorStop(1, "rgba(150,190,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 3.8, 0, Math.PI * 2);
    ctx.fill();

    // Solid Moon disc
    const moonGrad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r);
    moonGrad.addColorStop(0, "rgba(248,252,255,0.98)");
    moonGrad.addColorStop(1, "rgba(205,225,245,0.88)");
    ctx.fillStyle = moonGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Crescent shadow cutout via destination-out
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(cx + r * 0.32, cy - r * 0.05, r * 0.88, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // 7. LAYER 3: LIGHTING LAYER (Sun, God Rays, Horizon Glow, Vignette)
  // ─────────────────────────────────────────────────────────────
  function drawSun(ctx, W, H, timeOfDay, t, globalAlpha) {
    const isDawn = timeOfDay === "dawn";
    const isDusk = timeOfDay === "dusk";
    const isTwilight = isDawn || isDusk;

    const cx = W * (isTwilight ? 0.78 : 0.74);
    const cy = isTwilight ? H * 0.58 : H * 0.16;
    const sunR = Math.min(W, H) * (isTwilight ? 0.068 : 0.055);

    ctx.save();
    ctx.globalAlpha = globalAlpha;

    // 1. Broad outer atmospheric radial glow
    const outerGrad = ctx.createRadialGradient(cx, cy, sunR * 0.4, cx, cy, sunR * 5.5);
    if (isTwilight) {
      outerGrad.addColorStop(0, "rgba(255,150,60,0.28)");
      outerGrad.addColorStop(0.5, "rgba(255,120,40,0.10)");
      outerGrad.addColorStop(1, "rgba(255,100,20,0)");
    } else {
      outerGrad.addColorStop(0, "rgba(255,242,180,0.22)");
      outerGrad.addColorStop(0.5, "rgba(255,230,150,0.08)");
      outerGrad.addColorStop(1, "rgba(255,220,120,0)");
    }
    ctx.fillStyle = outerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, sunR * 5.5, 0, Math.PI * 2);
    ctx.fill();

    // 2. Crisp animated Sun disc
    const discGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
    if (isTwilight) {
      discGrad.addColorStop(0, "rgba(255,240,140,1)");
      discGrad.addColorStop(0.6, "rgba(255,160,50,0.96)");
      discGrad.addColorStop(1, "rgba(240,90,30,0.82)");
    } else {
      discGrad.addColorStop(0, "rgba(255,255,230,1)");
      discGrad.addColorStop(0.55, "rgba(255,242,160,0.96)");
      discGrad.addColorStop(1, "rgba(255,215,90,0.80)");
    }
    ctx.fillStyle = discGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
    ctx.fill();

    // 3. Atmospheric rotating God Rays (HIGH & ULTRA tiers only)
    if (Perf.tier === "ULTRA" || Perf.tier === "HIGH") {
      const rayCount = 12;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.0014);

      for (let i = 0; i < rayCount; i++) {
        const angle = (Math.PI * 2 * i) / rayCount;
        const len = sunR * (2.4 + 0.8 * Math.sin(t * 0.02 + i));
        const rayAlpha = (isTwilight ? 0.07 : 0.05) * (0.8 + 0.2 * Math.sin(t * 0.03 + i * 1.5));
        const strokeColor = isTwilight ? `rgba(255,200,120,${rayAlpha})` : `rgba(255,245,200,${rayAlpha})`;

        const rayGrad = ctx.createLinearGradient(
          Math.cos(angle) * sunR * 1.05,
          Math.sin(angle) * sunR * 1.05,
          Math.cos(angle) * len,
          Math.sin(angle) * len
        );
        rayGrad.addColorStop(0, strokeColor);
        rayGrad.addColorStop(1, "rgba(255,240,180,0)");

        ctx.beginPath();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = rayGrad;
        ctx.moveTo(Math.cos(angle) * sunR * 1.1, Math.sin(angle) * sunR * 1.1);
        ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  function drawHorizonGlow(ctx, W, H, timeOfDay, globalAlpha) {
    if (timeOfDay !== "dawn" && timeOfDay !== "dusk") return;
    ctx.save();
    ctx.globalAlpha = globalAlpha;

    // Bleeds from bottom up ~35% of canvas height
    const glowH = H * 0.35;
    const grad = ctx.createLinearGradient(0, H, 0, H - glowH);
    grad.addColorStop(0, "rgba(255,200,100,0.18)");
    grad.addColorStop(0.6, "rgba(255,160,70,0.08)");
    grad.addColorStop(1, "rgba(255,140,50,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - glowH, W, glowH);

    ctx.restore();
  }

  function drawStormVignette(ctx, W, H, t, globalAlpha) {
    ctx.save();
    ctx.globalAlpha = globalAlpha;

    // 20% dark radial vignette that pulses ±3% on a 0.8s sine wave
    const pulse = 0.20 + 0.03 * Math.sin(t * 0.08);
    const minDim = Math.min(W, H);
    const maxDim = Math.max(W, H);
    const vigGrad = ctx.createRadialGradient(W / 2, H / 2, minDim * 0.30, W / 2, H / 2, maxDim * 0.85);
    vigGrad.addColorStop(0, "rgba(10,12,18,0)");
    vigGrad.addColorStop(0.7, `rgba(10,12,18,${pulse * 0.6})`);
    vigGrad.addColorStop(1, `rgba(10,12,18,${pulse})`);

    ctx.fillStyle = vigGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // LIGHTNING STROBE SYSTEM (Storms)
  // ─────────────────────────────────────────────────────────────
  let _lightningTimer = null;
  let _lightningOverlay = null;

  function startLightning() {
    stopLightning();
    function schedule() {
      _lightningTimer = setTimeout(() => {
        flash();
        schedule();
      }, rand(5000, 12000));
    }
    schedule();
  }

  function flash() {
    if (!_lightningOverlay) {
      _lightningOverlay = document.createElement("div");
      _lightningOverlay.id = "wb-lightning";
      _lightningOverlay.style.cssText =
        "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;" +
        "z-index:0;opacity:0;background:rgba(225,235,255,0.16);transition:opacity 0.04s;";
      document.body.appendChild(_lightningOverlay);
    }
    // Realistic double pulse
    _lightningOverlay.style.opacity = "1";
    setTimeout(() => {
      _lightningOverlay.style.opacity = "0";
      setTimeout(() => {
        _lightningOverlay.style.opacity = "0.78";
        setTimeout(() => {
          _lightningOverlay.style.opacity = "0";
        }, 70);
      }, 85);
    }, 50);
  }

  function stopLightning() {
    if (_lightningTimer) {
      clearTimeout(_lightningTimer);
      _lightningTimer = null;
    }
    if (_lightningOverlay) {
      _lightningOverlay.remove();
      _lightningOverlay = null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 8. LAYER 4: VOLUMETRIC CLOUD LAYER (3-Depth Procedural)
  // ─────────────────────────────────────────────────────────────
  function buildClouds(type, W, H, icon) {
    const isStorm = type === "storm";
    const isRain = type === "rain" || isStorm;
    const isNight = isNightIcon(icon);

    const clouds = [];

    // Far layer — fast, small, light
    const farCount = Perf.count(isRain ? 5 : 4);
    for (let i = 0; i < farCount; i++) {
      clouds.push({
        x: rand(0, W),
        y: rand(H * 0.02, H * 0.22),
        scale: rand(0.32, 0.58),
        speed: rand(0.06, 0.12),
        alpha: isStorm ? rand(0.55, 0.78) : isNight ? rand(0.25, 0.40) : rand(0.30, 0.50),
        dark: isStorm,
        layer: "far",
      });
    }

    // Mid layer — medium size and speed
    if (Perf.tier !== "LOW") {
      const midCount = Perf.count(isRain ? 5 : 4);
      for (let i = 0; i < midCount; i++) {
        clouds.push({
          x: rand(0, W),
          y: rand(H * 0.08, H * 0.36),
          scale: rand(0.70, 1.10),
          speed: rand(0.04, 0.09),
          alpha: isStorm ? rand(0.75, 0.94) : isNight ? rand(0.35, 0.55) : rand(0.42, 0.68),
          dark: isStorm || isRain,
          layer: "mid",
        });
      }
    }

    // Near layer — large, slow, dominant (HIGH/ULTRA tiers)
    if (Perf.tier === "ULTRA" || Perf.tier === "HIGH") {
      const nearCount = Perf.count(type === "cloudy" ? 4 : isRain ? 4 : 2);
      for (let i = 0; i < nearCount; i++) {
        clouds.push({
          x: rand(0, W),
          y: rand(H * 0.04, H * 0.34),
          scale: rand(1.20, 1.95),
          speed: rand(0.02, 0.06),
          alpha: isStorm ? rand(0.85, 0.98) : isNight ? rand(0.42, 0.64) : rand(0.52, 0.78),
          dark: isStorm || isRain,
          layer: "near",
        });
      }
    }

    return clouds;
  }

  function drawCloud(ctx, cloud, isNight, type, globalAlpha) {
    ctx.save();
    ctx.globalAlpha = cloud.alpha * globalAlpha;

    const isStorm = type === "storm" || cloud.dark;
    const isRain = type === "rain";

    // 1. Base Cloud Tone
    let baseColor;
    if (isStorm) {
      baseColor = "#161820"; // near-black storm tone
    } else if (isRain) {
      baseColor = isNight ? "rgba(35,44,56,1)" : "rgba(65,78,92,1)";
    } else {
      baseColor = isNight
        ? "rgba(165,182,205,1)"
        : cloud.layer === "far"
        ? "rgba(225,238,252,1)"
        : "rgba(244,250,255,1)";
    }

    ctx.translate(cloud.x, cloud.y);
    ctx.scale(cloud.scale, cloud.scale * 0.62);

    // 2. Draw natural cloud volume from 6 overlapping ellipses
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, 56, 36, 0, 0, Math.PI * 2);
    ctx.ellipse(-38, 4, 38, 24, 0.1, 0, Math.PI * 2);
    ctx.ellipse(14, -22, 44, 30, -0.15, 0, Math.PI * 2);
    ctx.ellipse(54, -14, 40, 26, 0.1, 0, Math.PI * 2);
    ctx.ellipse(86, 2, 46, 28, 0.05, 0, Math.PI * 2);
    ctx.ellipse(22, 12, 54, 22, 0, 0, Math.PI * 2);
    ctx.fill();

    // 3. Bright Top Highlight (zenith radial gradient facing upward)
    if (!isStorm) {
      const hgAlpha = isNight ? 0.09 : 0.26;
      const hgGrad = ctx.createRadialGradient(24, -30, 4, 24, -20, 55);
      hgGrad.addColorStop(0, `rgba(255,255,255,${hgAlpha})`);
      hgGrad.addColorStop(1, "rgba(255,255,255,0)");

      ctx.fillStyle = hgGrad;
      ctx.beginPath();
      ctx.ellipse(24, -20, 42, 18, -0.1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Subtle charcoal highlight on storm crown
      ctx.fillStyle = "rgba(70,82,100,0.30)";
      ctx.beginPath();
      ctx.ellipse(20, -22, 40, 16, -0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Dark flat underside shadow for volume depth
    const underAlpha = isStorm ? 0.45 : isRain ? 0.28 : 0.14;
    ctx.fillStyle = `rgba(0,0,0,${underAlpha})`;
    ctx.beginPath();
    ctx.ellipse(36, 22, 60, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function updateClouds(clouds, W, H) {
    clouds.forEach((c) => {
      c.x += c.speed;
      const cloudW = 220 * c.scale;
      if (c.x - cloudW > W) {
        c.x = -cloudW;
        c.y = rand(
          c.layer === "far" ? H * 0.02 : H * 0.05,
          c.layer === "near" ? H * 0.32 : H * 0.36
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 9. LAYER 5: PARTICLE LAYER (Rain, Snow, Sun Motes)
  // ─────────────────────────────────────────────────────────────

  // RAIN: 3 Depth Strata (Far, Mid, Near)
  function buildRain(W, H, isStorm) {
    const total = Perf.count(isStorm ? 240 : 155);
    const strata = [
      // Far: slow, short, faint, near-vertical
      { ratio: 0.35, speedMin: 8, speedMax: 12, lenMin: 8, lenMax: 14, alpha: 0.24, width: 0.65, angle: 0.12 },
      // Mid: medium speed & angle
      { ratio: 0.40, speedMin: 13, speedMax: 19, lenMin: 15, lenMax: 24, alpha: 0.52, width: 0.95, angle: 0.20 },
      // Near: fast, long, clearly diagonal, highest alpha
      { ratio: 0.25, speedMin: 20, speedMax: 28, lenMin: 25, lenMax: 36, alpha: 0.82, width: 1.35, angle: 0.28 },
    ];

    const drops = [];
    strata.forEach((st) => {
      const count = Math.round(total * st.ratio);
      for (let i = 0; i < count; i++) {
        drops.push({
          x: rand(0, W),
          y: rand(-H, 0),
          len: rand(st.lenMin, st.lenMax),
          speed: rand(st.speedMin, st.speedMax),
          alpha: rand(st.alpha * 0.8, st.alpha * 1.2),
          width: st.width,
          angle: st.angle,
        });
      }
    });
    return drops;
  }

  function drawRain(ctx, drops, W, H, globalAlpha) {
    drops.forEach((d) => {
      ctx.save();
      ctx.globalAlpha = d.alpha * globalAlpha;
      ctx.strokeStyle = "rgba(180,218,245,1)";
      ctx.lineWidth = d.width;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * d.angle, d.y + d.len);
      ctx.stroke();
      ctx.restore();

      d.y += d.speed;
      d.x -= d.speed * d.angle;

      if (d.y > H + 30) {
        d.y = rand(-50, -5);
        d.x = rand(0, W + 100);
      }
      if (d.x < -30) {
        d.x = W + 30;
      }
    });
  }

  // SNOW: 4 Size Classes with Independent Wobbles
  function buildSnow(W, H) {
    const total = Perf.count(130);
    const classes = [
      { ratio: 0.40, rMin: 1.0, rMax: 1.6, speedMin: 0.5, speedMax: 1.1, alpha: 0.55 },
      { ratio: 0.30, rMin: 1.8, rMax: 2.6, speedMin: 1.0, speedMax: 1.8, alpha: 0.72 },
      { ratio: 0.20, rMin: 2.8, rMax: 3.8, speedMin: 1.4, speedMax: 2.4, alpha: 0.85 },
      { ratio: 0.10, rMin: 4.0, rMax: 5.2, speedMin: 1.8, speedMax: 2.8, alpha: 0.94 },
    ];

    const flakes = [];
    classes.forEach((cl) => {
      const count = Math.round(total * cl.ratio);
      for (let i = 0; i < count; i++) {
        flakes.push({
          x: rand(0, W),
          y: rand(-H, 0),
          r: rand(cl.rMin, cl.rMax),
          speed: rand(cl.speedMin, cl.speedMax),
          drift: rand(-0.25, 0.25),
          alpha: cl.alpha,
          wobble: rand(0, Math.PI * 2),
          wobbleSpeed: rand(0.008, 0.024),
        });
      }
    });
    return flakes;
  }

  function drawSnow(ctx, flakes, W, H, globalAlpha) {
    flakes.forEach((f) => {
      f.wobble += f.wobbleSpeed;
      f.x += f.drift + Math.sin(f.wobble) * 0.55;
      f.y += f.speed;

      if (f.y > H + 12) {
        f.y = rand(-25, -5);
        f.x = rand(0, W);
      }
      if (f.x < -12) f.x = W + 12;
      if (f.x > W + 12) f.x = -12;

      ctx.save();
      ctx.globalAlpha = f.alpha * globalAlpha;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(215,238,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // SUN MOTES: Golden Atmospheric Dust Particles
  function buildMotes(W, H) {
    const count = Perf.count(12);
    return Array.from({ length: count }, () => ({
      x: rand(0, W),
      y: rand(0, H),
      r: rand(1.5, 3.4),
      dx: rand(-0.14, 0.14),
      dy: rand(-0.10, -0.25),
      alpha: rand(0.20, 0.50),
      pulse: rand(0, Math.PI * 2),
    }));
  }

  function drawMotes(ctx, motes, W, H, globalAlpha) {
    motes.forEach((m) => {
      m.x += m.dx;
      m.y += m.dy;
      m.pulse += 0.02;

      if (m.y < -6) { m.y = H + 6; m.x = rand(0, W); }
      if (m.x < -6) m.x = W + 6;
      if (m.x > W + 6) m.x = -6;

      const a = m.alpha * (0.75 + 0.25 * Math.sin(m.pulse)) * globalAlpha;
      ctx.save();
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,238,130,0.92)";
      ctx.fill();
      ctx.restore();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 10. LAYER 6: ATMOSPHERE LAYER (Fog, Ground Mist, Color Grading)
  // ─────────────────────────────────────────────────────────────
  function buildFogBands() {
    return [
      { yFrac: 0.18, speed: 0.018, amp: 22, phase: 0.0, alpha: 0.18, hFrac: 0.20 },
      { yFrac: 0.44, speed: -0.012, amp: 26, phase: 1.2, alpha: 0.16, hFrac: 0.22 },
      { yFrac: 0.70, speed: 0.009, amp: 18, phase: 2.3, alpha: 0.18, hFrac: 0.18 },
      { yFrac: 0.88, speed: -0.007, amp: 12, phase: 3.4, alpha: 0.14, hFrac: 0.15 },
    ];
  }

  function drawFog(ctx, bands, W, H, t, globalAlpha, fogColor) {
    ctx.save();
    bands.forEach((b) => {
      const yOffset = Math.sin(t * b.speed * 8 + b.phase) * b.amp;
      const bY = H * b.yFrac + yOffset;
      const bH = H * b.hFrac;

      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, `rgba(${fogColor},0)`);
      grad.addColorStop(0.25, `rgba(${fogColor},${b.alpha * globalAlpha})`);
      grad.addColorStop(0.75, `rgba(${fogColor},${b.alpha * globalAlpha})`);
      grad.addColorStop(1, `rgba(${fogColor},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, bY - bH / 2, W, bH);
    });

    // Gentle horizon haze
    const hazeGrad = ctx.createLinearGradient(0, H * 0.55, 0, H);
    hazeGrad.addColorStop(0, `rgba(${fogColor},0)`);
    hazeGrad.addColorStop(1, `rgba(${fogColor},${0.24 * globalAlpha})`);
    ctx.fillStyle = hazeGrad;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);

    ctx.restore();
  }

  function drawGroundMist(ctx, W, H, dense, globalAlpha) {
    ctx.save();
    const mistAlpha = (dense ? 0.18 : 0.10) * globalAlpha;
    const mistH = H * 0.18; // bottom 18% of canvas
    const grad = ctx.createLinearGradient(0, H - mistH, 0, H);
    grad.addColorStop(0, "rgba(180,205,225,0)");
    grad.addColorStop(0.6, `rgba(180,205,225,${mistAlpha})`);
    grad.addColorStop(1, `rgba(180,205,225,${mistAlpha * 1.4})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - mistH, W, mistH);
    ctx.restore();
  }

  function drawColorGrading(ctx, W, H, type, timeOfDay, globalAlpha) {
    ctx.save();
    let tint = null;

    if (type === "storm") {
      tint = `rgba(30,40,80,${0.06 * globalAlpha})`;
    } else if (timeOfDay === "dusk" || timeOfDay === "dawn") {
      tint = `rgba(255,180,80,${0.045 * globalAlpha})`;
    } else if (type === "snow") {
      tint = `rgba(180,215,255,${0.035 * globalAlpha})`;
    } else if (timeOfDay === "night") {
      tint = `rgba(20,30,55,${0.05 * globalAlpha})`;
    } else if (type === "clear") {
      tint = `rgba(255,245,210,${0.025 * globalAlpha})`;
    }

    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // 11. TRANSITION CONTROLLER (4-Second Smoothstep Cross-Fade)
  // ─────────────────────────────────────────────────────────────
  const TRANSITION_DURATION = 4000; // 4 seconds
  let _transitionStart = 0;
  let _fromPalette = null;
  let _toPalette = null;
  let _fromType = null;
  let _toType = null;
  let _fromSceneObj = null;
  let _toSceneObj = null;

  function startTransition(fromObj, toObj, fromKey, toKey) {
    _transitionStart = performance.now();
    _fromSceneObj = fromObj;
    _toSceneObj = toObj;
    _fromType = fromKey;
    _toType = toKey;
    _fromPalette = SkyPalettes[fromKey] || SkyPalettes.default;
    _toPalette = SkyPalettes[toKey] || SkyPalettes.default;
  }

  function getTransitionProgress() {
    if (!_transitionStart) return 1;
    const elapsed = performance.now() - _transitionStart;
    return clamp(elapsed / TRANSITION_DURATION, 0, 1);
  }

  // ─────────────────────────────────────────────────────────────
  // 12. CANVAS & ANIMATION ENGINE LIFECYCLE
  // ─────────────────────────────────────────────────────────────
  let _canvas = null;
  let _ctx = null;
  let _rafId = null;
  let _paused = false;
  let _currentKey = null;
  let _currentScene = null;
  let _currentType = null;
  let _t = 0;

  function createCanvas() {
    const c = document.createElement("canvas");
    c.className = "wb-canvas";
    c.setAttribute("aria-hidden", "true");

    // Cap DPR at 2 — avoids 4K rendering cost on very high-DPI screens.
    // CSS size stays 100vw/100vh (set in .wb-canvas rule), so rendering
    // remains sharp on Retina but skips unnecessary 3x/4x overdraw.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width  = Math.round(window.innerWidth  * dpr);
    c.height = Math.round(window.innerHeight * dpr);
    c.style.width  = window.innerWidth  + "px";
    c.style.height = window.innerHeight + "px";

    // GPU compositing hint — promotes canvas to its own layer
    c.style.willChange = "transform";

    document.body.insertBefore(c, document.body.firstChild);

    c._dpr = dpr;
    c._resize = () => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      c._dpr = d;
      c.width  = Math.round(window.innerWidth  * d);
      c.height = Math.round(window.innerHeight * d);
      c.style.width  = window.innerWidth  + "px";
      c.style.height = window.innerHeight + "px";
    };
    window.addEventListener("resize", c._resize);
    return c;
  }

  function removeCanvas() {
    if (_canvas) {
      window.removeEventListener("resize", _canvas._resize);
      _canvas.remove();
      _canvas = null;
      _ctx = null;
    }
  }

  function stopAll() {
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    stopLightning();
    removeCanvas();
    _currentScene = null;
    _fromSceneObj = null;
    _toSceneObj = null;
    _currentKey = null;
    _currentType = null;
  }

  function createSceneAssets(type, icon, W, H) {
    const timeOfDay = getTimeOfDay(icon);
    const isNight = timeOfDay === "night";

    return {
      type,
      icon,
      timeOfDay,
      isNight,
      clouds: buildClouds(type, W, H, icon),
      stars: isNight ? buildStars(W, H) : null,
      motes: type === "clear" && !isNight ? buildMotes(W, H) : null,
      drops: type === "rain" || type === "storm" ? buildRain(W, H, type === "storm") : null,
      flakes: type === "snow" ? buildSnow(W, H) : null,
      fogBands: type === "fog" ? buildFogBands() : null,
    };
  }

  function renderSceneEntities(ctx, scene, W, H, t, alpha) {
    if (!scene || alpha <= 0.001) return;

    // 2. Star/Moon Layer
    if (scene.isNight) {
      if (scene.stars) drawStars(ctx, scene.stars, t, alpha);
      if (scene.type === "clear" || (scene.type === "cloudy" && Perf.tier !== "LOW")) {
        drawMoon(ctx, W, H, t, alpha);
      }
    }

    // 3. Lighting Layer
    if (!scene.isNight && (scene.type === "clear" || scene.type === "default")) {
      drawSun(ctx, W, H, scene.timeOfDay, t, alpha);
    }
    drawHorizonGlow(ctx, W, H, scene.timeOfDay, alpha);
    if (scene.type === "storm") {
      drawStormVignette(ctx, W, H, t, alpha);
    }

    // 4. Cloud Layer
    if (scene.clouds) {
      updateClouds(scene.clouds, W, H);
      const sorted = scene.clouds.slice().sort((a, b) => {
        const order = { far: 0, mid: 1, near: 2 };
        return order[a.layer] - order[b.layer];
      });
      sorted.forEach((c) => drawCloud(ctx, c, scene.isNight, scene.type, alpha));
    }

    // 5. Particle Layer
    if (scene.drops) {
      drawRain(ctx, scene.drops, W, H, alpha);
      if (scene.type === "storm" || Perf.tier === "ULTRA" || Perf.tier === "HIGH") {
        drawGroundMist(ctx, W, H, scene.type === "storm", alpha);
      }
    }
    if (scene.flakes) {
      drawSnow(ctx, scene.flakes, W, H, alpha);
    }
    if (scene.motes) {
      drawMotes(ctx, scene.motes, W, H, alpha);
    }

    // 6. Atmosphere Layer
    if (scene.fogBands) {
      drawFog(ctx, scene.fogBands, W, H, t, alpha, "210,225,238");
    }
    drawColorGrading(ctx, W, H, scene.type, scene.timeOfDay, alpha);
  }

  function mainRenderLoop() {
    if (_paused || !_canvas || !_ctx) return;

    const W = _canvas.width;
    const H = _canvas.height;
    const ctx = _ctx;
    _t++;

    ctx.clearRect(0, 0, W, H);

    const rawT = getTransitionProgress();
    const easeT = smoothstep(rawT);
    const isTransitioning = rawT < 1.0 && _fromPalette && _toPalette;

    // 1. Sky Layer (HDR-style interpolated 4-stop gradient sky)
    let activePalette;
    if (isTransitioning) {
      activePalette = lerpPalette(_fromPalette, _toPalette, easeT);
    } else {
      activePalette = SkyPalettes[_currentKey] || SkyPalettes.default;
    }
    drawSky(ctx, W, H, activePalette);

    // Render outgoing scene during transition (lerps 1 → 0)
    if (isTransitioning && _fromSceneObj) {
      renderSceneEntities(ctx, _fromSceneObj, W, H, _t, 1 - easeT);
    }

    // Render incoming scene (lerps 0 → 1)
    if (_currentScene) {
      const incomingAlpha = isTransitioning ? easeT : 1.0;
      renderSceneEntities(ctx, _currentScene, W, H, _t, incomingAlpha);
    }

    _rafId = requestAnimationFrame(mainRenderLoop);
  }

  // Handle tab switching: pause when backgrounded, resume without runaway delta
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      _paused = true;
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
      }
    } else {
      _paused = false;
      if (_canvas && _currentScene && !_rafId) {
        _rafId = requestAnimationFrame(mainRenderLoop);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 13. PUBLIC API: updateWeatherBackground
  // ─────────────────────────────────────────────────────────────
  function updateWeatherBackground(conditionOrObj) {
    let rawCondition = conditionOrObj;
    let icon = null;

    if (conditionOrObj && typeof conditionOrObj === "object") {
      rawCondition = conditionOrObj.condition || "";
      icon = conditionOrObj.icon || null;
    }

    const type = normalizeCondition(rawCondition);
    const targetKey = resolveSceneKey(type, icon);

    // 1. Update body gradient fallback immediately (smooth 5s CSS transition)
    applyBodyGradient(targetKey);

    // 2. Skip heavy canvas loop if prefers-reduced-motion
    if (Perf.reducedMotion) {
      stopAll();
      return;
    }

    // 3. Prevent duplicate reconstruction for exact same scene state
    if (targetKey === _currentKey && _canvas) {
      return;
    }

    const prevSceneObj = _currentScene;
    const prevKey = _currentKey;

    _currentKey = targetKey;
    _currentType = type;

    // Ensure canvas exists
    if (!_canvas) {
      _canvas = createCanvas();
      _ctx = _canvas.getContext("2d");
    }

    // Build incoming scene entities
    const newSceneObj = createSceneAssets(type, icon, _canvas.width, _canvas.height);
    _currentScene = newSceneObj;

    // Handle lightning controller
    if (type === "storm") {
      startLightning();
    } else {
      stopLightning();
    }

    // Start 4-second smooth cross-fade from outgoing scene if one was active
    if (prevSceneObj && prevKey) {
      startTransition(prevSceneObj, newSceneObj, prevKey, targetKey);
    } else {
      _transitionStart = 0;
      _fromPalette = null;
      _toPalette = null;
    }

    // Start animation loop if not running
    if (!_rafId && !document.hidden) {
      _rafId = requestAnimationFrame(mainRenderLoop);
    }
  }

  // Expose to window / global scope
  global.updateWeatherBackground = updateWeatherBackground;
  global.WeatherBackground = {
    setWeather(condition, isDaytime) {
      updateWeatherBackground({
        condition,
        icon: isDaytime ? "01d" : "01n",
      });
    },
    update: updateWeatherBackground,
  };
})(window);
