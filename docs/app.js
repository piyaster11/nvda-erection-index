/* NVIDIA Erection Index — client. Prefers precomputed docs/data/index.json
   (no CORS issues). Optionally recomputes from a live Yahoo Finance fetch
   using the same formulas as scripts/compute_index.py. */

const YAHOO_URLS = [
  "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=2y&interval=1d&events=history",
  "https://query2.finance.yahoo.com/v8/finance/chart/NVDA?range=2y&interval=1d&events=history",
];
const LOCAL_JSON = "./data/index.json";

const MA_WINDOW = 125;
const RSI_WINDOW = 14;
const VOL_SHORT = 20;
const VOL_LONG = 252;
const HIGH_LOW_WINDOW = 252;
const RET_SHORT = 5;
const RET_MEDIUM = 20;
const MOMENTUM_SCALE = 0.2;
const RET5_SCALE = 0.08;
const RET20_SCALE = 0.15;
const VOL_RATIO_SCALE = 0.4;

const ZONES = [
  { min: 0, max: 25, id: "limp", label: "Limp / Extreme Fear", short: "Limp", color: "#e23d3d" },
  { min: 25, max: 45, id: "fear", label: "Half-mast / Fear", short: "Half-mast", color: "#f08a2a" },
  { min: 45, max: 56, id: "neutral", label: "Neutral", short: "Neutral", color: "#e6c84f" },
  { min: 56, max: 76, id: "greed", label: "Rising / Greed", short: "Rising", color: "#a8d44a" },
  { min: 76, max: 100.0001, id: "extreme_greed", label: "Rock Hard / Extreme Greed", short: "Rock Hard", color: "#76b900" },
];

const params = new URLSearchParams(location.search);
const STATIC = params.has("static") || params.get("static") === "1";
const reduceMotion = STATIC || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel) => document.querySelector(sel);

function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

function tanh(x) {
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

function tanhScore(x, scale) {
  return 50 + 50 * tanh(x / scale);
}

function zoneFor(score) {
  const s = Math.round(score);
  if (s < 25) return ZONES[0];
  if (s < 45) return ZONES[1];
  if (s < 56) return ZONES[2];
  if (s < 76) return ZONES[3];
  return ZONES[4];
}

function zoneClass(id) {
  return `zone-${id}`;
}

function formatMoney(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function scoreToAngle(score) {
  return (clamp(score) / 100) * 180 - 90;
}

/* ---------- live recompute (mirrors compute_index.py) ---------- */

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pstdev(arr) {
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function wilderRsi(prices, period = RSI_WINDOW) {
  const n = prices.length;
  const out = Array(n).fill(null);
  if (n <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = prices[i] - prices[i - 1];
    avgGain += Math.max(ch, 0);
    avgLoss += Math.max(-ch, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 && avgGain === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 && avgGain === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function rollingMean(values, window) {
  const out = Array(values.length).fill(null);
  if (values.length < window) return out;
  let acc = 0;
  for (let i = 0; i < window; i++) acc += values[i];
  out[window - 1] = acc / window;
  for (let i = window; i < values.length; i++) {
    acc += values[i] - values[i - window];
    out[i] = acc / window;
  }
  return out;
}

function dailyReturns(prices) {
  const out = [null];
  for (let i = 1; i < prices.length; i++) {
    out.push(prices[i - 1] === 0 ? null : prices[i] / prices[i - 1] - 1);
  }
  return out;
}

function rollingStd(values, window, end) {
  const chunk = [];
  for (let i = end; i >= 0 && chunk.length < window; i--) {
    if (values[i] != null) chunk.push(values[i]);
  }
  if (chunk.length < window) return null;
  return pstdev(chunk);
}

function rangeHighLow(highs, lows, end, window) {
  const start = end - window + 1;
  if (start < 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= end; i++) {
    if (highs[i] > hi) hi = highs[i];
    if (lows[i] < lo) lo = lows[i];
  }
  return [hi, lo];
}

function componentsAt(i, prices, highs, lows, ma125, rsi, rets) {
  const price = prices[i];
  const ma = ma125[i];
  const rsiV = rsi[i];
  if (ma == null || ma === 0 || rsiV == null || i < RET_MEDIUM) return null;
  const hl = rangeHighLow(highs, lows, i, HIGH_LOW_WINDOW);
  const vol20 = rollingStd(rets, VOL_SHORT, i);
  const vol1y = rollingStd(rets, VOL_LONG, i);
  if (!hl || vol20 == null || !vol1y) return null;

  const [high52, low52] = hl;
  const momPct = price / ma - 1;
  const momentum = clamp(tanhScore(momPct, MOMENTUM_SCALE));
  const rsiScore = clamp(rsiV);
  const span = high52 - low52;
  const rangePos = span <= 0 ? 0.5 : (price - low52) / span;
  const rangeScore = span <= 0 ? 50 : clamp(rangePos * 100);
  const volRatio = vol20 / vol1y;
  const volScore = clamp(tanhScore(1 - volRatio, VOL_RATIO_SCALE));
  const ret5 = price / prices[i - RET_SHORT] - 1;
  const ret20 = price / prices[i - RET_MEDIUM] - 1;
  const retScore = clamp((tanhScore(ret5, RET5_SCALE) + tanhScore(ret20, RET20_SCALE)) / 2);

  const parts = [
    {
      id: "momentum",
      name: "Price vs 125-day MA",
      description: "How far the adjusted close sits above or below its 125-session moving average.",
      value_label: `${(momPct * 100).toFixed(1)}% vs 125-day MA`.replace(/^([^-])/, "+$1").replace("+-", "-"),
      score: momentum,
      ma125: ma,
      pct_vs_ma: +(momPct * 100).toFixed(2),
    },
    {
      id: "rsi",
      name: "14-day RSI",
      description: "Wilder relative strength index. High RSI leans greedy; low RSI leans fearful.",
      value_label: rsiV.toFixed(1),
      score: rsiScore,
      rsi: +rsiV.toFixed(2),
    },
    {
      id: "range",
      name: "52-week high / low",
      description: "Where the latest close sits between the 52-week high and low (using daily highs and lows).",
      value_label: `${(rangePos * 100).toFixed(1)}% of 52-week range`,
      score: rangeScore,
      high52,
      low52,
      range_pct: +(rangePos * 100).toFixed(2),
    },
    {
      id: "volatility",
      name: "20-day vs 1-year volatility",
      description: "Inverse reading: short-term volatility above its 1-year average scores lower (fear); calmer tape scores higher.",
      value_label: `${volRatio.toFixed(2)}× the 1-year average`,
      score: volScore,
      ratio: +volRatio.toFixed(3),
      vol20: +(vol20 * 100).toFixed(3),
      vol1y: +(vol1y * 100).toFixed(3),
    },
    {
      id: "returns",
      name: "5 / 20-day return",
      description: "Average of short-term (5-session) and medium-term (20-session) price returns.",
      value_label: `${(ret5 * 100).toFixed(1)}% (5d) · ${(ret20 * 100).toFixed(1)}% (20d)`.replace(/ (% \(5d\))/,"+$1").replace(/\+-/,"-"),
      score: retScore,
      ret5_pct: +(ret5 * 100).toFixed(2),
      ret20_pct: +(ret20 * 100).toFixed(2),
    },
  ];
  // Fix signed percent labels more carefully
  parts[0].value_label = `${momPct >= 0 ? "+" : ""}${(momPct * 100).toFixed(1)}% vs 125-day MA`;
  parts[4].value_label = `${ret5 >= 0 ? "+" : ""}${(ret5 * 100).toFixed(1)}% (5d) · ${ret20 >= 0 ? "+" : ""}${(ret20 * 100).toFixed(1)}% (20d)`;

  const scoreRaw = mean(parts.map((p) => p.score));
  const z = zoneFor(scoreRaw);
  return {
    score_raw: scoreRaw,
    score: Math.round(scoreRaw),
    label: z.label,
    label_short: z.short,
    zone: z.id,
    price,
    components: parts.map((p) => ({ ...p, score: +p.score.toFixed(1) })),
  };
}

function buildFromYahoo(payload, sourceUrl) {
  const result = payload.chart.result[0];
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const adjList = (result.indicators.adjclose && result.indicators.adjclose[0].adjclose) || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    const d = new Date(ts[i] * 1000);
    // Format the session date in America/New_York
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const pick = (t) => parts.find((p) => p.type === t).value;
    const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
    bars.push({
      date,
      close: q.close[i],
      high: q.high[i],
      low: q.low[i],
      price: adjList[i] != null ? adjList[i] : q.close[i],
    });
  }
  const prices = bars.map((b) => b.price);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const ma125 = rollingMean(prices, MA_WINDOW);
  const rsi = wilderRsi(prices);
  const rets = dailyReturns(prices);
  const series = [];
  const byIndex = new Map();
  for (let i = 0; i < bars.length; i++) {
    const c = componentsAt(i, prices, highs, lows, ma125, rsi, rets);
    if (!c) continue;
    byIndex.set(i, c);
    series.push({
      date: bars[i].date,
      score: c.score,
      score_raw: +c.score_raw.toFixed(2),
      price: +bars[i].close.toFixed(4),
      label_short: c.label_short,
      zone: c.zone,
    });
  }
  const lastI = Math.max(...byIndex.keys());
  const current = byIndex.get(lastI);
  const last = bars[lastI];
  const prevPrice = lastI > 0 ? bars[lastI - 1].close : null;
  const change = prevPrice != null ? last.close - prevPrice : null;
  const snap = (i) => {
    if (!byIndex.has(i)) return null;
    const c = byIndex.get(i);
    return {
      date: bars[i].date,
      score: c.score,
      score_raw: +c.score_raw.toFixed(2),
      label: c.label,
      label_short: c.label_short,
      zone: c.zone,
      price: +c.price.toFixed(4),
      close: +bars[i].close.toFixed(4),
    };
  };
  const [y, m, d] = last.date.split("-").map(Number);
  const asOfLabel = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    symbol: "NVDA",
    source: "Yahoo Finance (live)",
    source_url: sourceUrl,
    as_of: last.date,
    as_of_label: asOfLabel,
    timezone: "America/New_York",
    generated_at: new Date().toISOString(),
    live: true,
    price: +last.close.toFixed(4),
    prev_close_price: prevPrice == null ? null : +prevPrice.toFixed(4),
    change: change == null ? null : +change.toFixed(4),
    change_pct: change == null || !prevPrice ? null : +((change / prevPrice) * 100).toFixed(2),
    score: current.score,
    score_raw: +current.score_raw.toFixed(2),
    label: current.label,
    label_short: current.label_short,
    zone: current.zone,
    components: current.components,
    history: {
      previous_close: snap(lastI - 1),
      week_ago: snap(lastI - 5),
      month_ago: snap(lastI - 21),
    },
    series,
  };
}

async function fetchYahoo() {
  for (const url of YAHOO_URLS) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.chart?.result?.[0]) continue;
      return { data, url };
    } catch {
      /* CORS or network — fall through */
    }
  }
  return null;
}

async function loadIndex() {
  // A live Yahoo fetch is opt-in (?live=1). Browsers normally block it with CORS,
  // which would spam the console; the daily-precomputed JSON is the default source.
  if (params.has("live")) {
    const live = await fetchYahoo();
    if (live) {
      try {
        return buildFromYahoo(live.data, live.url);
      } catch (err) {
        console.warn("Live compute failed, falling back to cached JSON", err);
      }
    }
  }
  const res = await fetch(LOCAL_JSON, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${LOCAL_JSON} (${res.status})`);
  const data = await res.json();
  data.live = false;
  return data;
}

/* ---------- gauge SVG ---------- */

const CX = 320;
const CY = 295;
const R = 232;
const TRACK = 34;

function polar(r, score) {
  const rad = ((180 - score * 1.8) * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
}

function arcPath(r, a, b) {
  const [sx, sy] = polar(r, a);
  const [ex, ey] = polar(r, b);
  const large = b - a > 50 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
}

function needleSvg() {
  // Cartoon penis: simple tapered shaft, rounded cap, two balls at the pivot.
  // Intentionally undetailed — no anatomical features.
  return `
    <g id="needle" class="needle" data-angle="-90" transform="rotate(-90)">
      <g filter="url(#needle-shadow)">
        <ellipse cx="-17" cy="12" rx="18" ry="16" fill="#e2a888" stroke="#5a3a30" stroke-width="2.2"/>
        <ellipse cx="17" cy="12" rx="18" ry="16" fill="#e2a888" stroke="#5a3a30" stroke-width="2.2"/>
        <ellipse cx="-22" cy="6.5" rx="6.5" ry="5" fill="#fbe4d4" opacity="0.7"/>
        <ellipse cx="12.5" cy="6.5" rx="6.5" ry="5" fill="#fbe4d4" opacity="0.55"/>
        <path d="M -10 10
                 C -10.5 -40 -11.5 -115 -10 -160
                 C -8.5 -176 8.5 -176 10 -160
                 C 11.5 -120 10.5 -40 10 10
                 Z"
              fill="#f0c4a8" stroke="#5a3a30" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M -10 -158
                 C -15 -164 -14 -188 0 -196
                 C 14 -188 15 -164 10 -158
                 C 4 -153 -4 -153 -10 -158 Z"
              fill="#f0c4a8" stroke="#5a3a30" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M -8 -160 Q 0 -155 8 -160" fill="none" stroke="#5a3a30" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
        <path d="M -5 -50 C -6 -110 -4.2 -160 -2.2 -182" fill="none" stroke="#fbe4d4" stroke-width="3.4" stroke-linecap="round" opacity="0.5"/>
        <ellipse cx="-1.6" cy="-184" rx="3.4" ry="2.5" fill="#fbe4d4" opacity="0.7"/>
      </g>
    </g>`;
}

function drawGauge() {
  const ticks = [0, 25, 50, 75, 100];
  const tickMarks = ticks
    .map((s) => {
      const [x1, y1] = polar(R + TRACK / 2 + 6, s);
      const [x2, y2] = polar(R + TRACK / 2 + 16, s);
      const [tx, ty] = polar(R + TRACK / 2 + 30, s);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#6b7368" stroke-width="1.5"/>
        <text class="tick-label" x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="middle">${s}</text>`;
    })
    .join("");

  const segments = ZONES.map((z) => {
    const a = z.min;
    const b = Math.min(z.max, 100);
    return `<path d="${arcPath(R, a, b)}" fill="none" stroke="${z.color}" stroke-width="${TRACK}" stroke-linecap="butt"/>`;
  }).join("");

  const zoneLabels = [
    { text: "LIMP", score: 8 },
    { text: "HALF MAST", score: 35 },
    { text: "NEUTRAL", score: 50.5 },
    { text: "RISING", score: 66 },
    { text: "ROCK HARD", score: 88 },
  ]
    .map((l) => {
      const [x, y] = polar(R, l.score);
      const rot = scoreToAngle(l.score);
      return `<text class="zone-label" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle"
        fill="#141414" transform="rotate(${rot} ${x} ${y})">${l.text}</text>`;
    })
    .join("");

  const svg = `
    <svg viewBox="0 0 640 360" role="img" aria-label="Erection index gauge">
      <defs>
        <filter id="needle-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000" flood-opacity="0.5"/>
        </filter>
        <filter id="arc-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <path d="${arcPath(R, 0, 100)}" fill="none" stroke="#1a221a" stroke-width="${TRACK + 12}"/>
      <g filter="url(#arc-glow)">${segments}</g>
      ${tickMarks}
      ${zoneLabels}
      <g transform="translate(${CX} ${CY})">
        ${needleSvg()}
      </g>
    </svg>`;
  $("#gauge").innerHTML = svg;
}

function setNeedle(score) {
  const el = document.getElementById("needle");
  if (!el) return;
  const angle = scoreToAngle(score);
  // SVG rotate() is around the current origin — the pivot — not the bounding box.
  el.setAttribute("transform", `rotate(${angle})`);
  el.dataset.angle = String(angle);
  el.dataset.score = String(score);
}

function easeOutElastic(t) {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3.2;
  return Math.pow(2, -11 * t) * Math.sin((t * 11 - 0.75) * c4) + 1;
}

function animateTo(target) {
  const valueEl = $("#score-value");
  if (reduceMotion) {
    setNeedle(target);
    valueEl.textContent = String(Math.round(target));
    document.documentElement.dataset.ready = "1";
    return;
  }
  const duration = 2200;
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = easeOutElastic(t);
    const current = target * eased;
    const visual = Math.max(0, Math.min(100, current));
    setNeedle(visual);
    valueEl.textContent = String(Math.round(Math.max(0, current)));
    if (t < 1) requestAnimationFrame(frame);
    else {
      setNeedle(target);
      valueEl.textContent = String(Math.round(target));
      document.documentElement.dataset.ready = "1";
    }
  }
  requestAnimationFrame(frame);
}

/* ---------- sparkline ---------- */

function drawSpark(series) {
  const svg = $("#spark");
  if (!svg || !series?.length) return;
  const w = 900;
  const h = 110;
  const pad = { l: 4, r: 4, t: 10, b: 16 };
  const xs = series.map((_, i) => pad.l + (i / (series.length - 1)) * (w - pad.l - pad.r));
  const ys = series.map((p) => pad.t + (1 - p.score / 100) * (h - pad.t - pad.b));
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(" ");
  const area = `${xs[0]},${h - pad.b} ${pts} ${xs[xs.length - 1]},${h - pad.b}`;

  // Color stops along the path would be heavy; use a single green-to-red by score via a gradient on y
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#76b900" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#76b900" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="axis" x1="${pad.l}" y1="${pad.t + (1 - 50 / 100) * (h - pad.t - pad.b)}" x2="${w - pad.r}" y2="${pad.t + (1 - 50 / 100) * (h - pad.t - pad.b)}" stroke-dasharray="3 5"/>
    <polygon points="${area}" fill="url(#sparkFill)"/>
    <polyline points="${pts}" fill="none" stroke="#76b900" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle id="spark-dot" r="4.5" fill="#f3f6f0" stroke="#76b900" stroke-width="2" visibility="hidden"/>
  `;

  const readout = $("#spark-readout");
  const last = series[series.length - 1];
  const first = series[0];
  readout.textContent = `${formatDate(first.date)} → ${formatDate(last.date)}`;

  const nearest = (evt) => {
    const rect = svg.getBoundingClientRect();
    const t = (evt.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(t * (series.length - 1))));
    return i;
  };

  const show = (i) => {
    const p = series[i];
    const dot = document.getElementById("spark-dot");
    dot.setAttribute("cx", xs[i]);
    dot.setAttribute("cy", ys[i]);
    dot.setAttribute("visibility", "visible");
    const z = zoneFor(p.score);
    readout.textContent = `${formatDate(p.date)}  ·  ${p.score}  ${z.short}  ·  $${formatMoney(p.price)}`;
  };
  const hide = () => {
    document.getElementById("spark-dot").setAttribute("visibility", "hidden");
    readout.textContent = `${formatDate(first.date)} → ${formatDate(last.date)}`;
  };

  svg.addEventListener("mousemove", (e) => show(nearest(e)));
  svg.addEventListener("touchmove", (e) => {
    if (e.touches[0]) show(nearest(e.touches[0]));
  }, { passive: true });
  svg.addEventListener("mouseleave", hide);
}

/* ---------- page bind ---------- */

function render(data) {
  document.title = `NVIDIA Erection Index — ${data.score} ${data.label_short}`;
  drawGauge();

  const z = zoneFor(data.score);
  const labelEl = $("#score-label");
  labelEl.textContent = data.label;
  labelEl.className = zoneClass(data.zone);

  const chg = data.change;
  const chgPct = data.change_pct;
  const up = chg != null && chg >= 0;
  const chgTxt =
    chg == null
      ? ""
      : `<span class="${up ? "up" : "down"}">${up ? "+" : ""}${formatMoney(chg)} (${up ? "+" : ""}${chgPct}%)</span>`;
  $("#price-line").innerHTML = `
    <span class="ticker">NVDA</span>
    <span>$${formatMoney(data.price)}</span>
    ${chgTxt}
  `;

  const liveNote = data.live ? " · live from Yahoo Finance" : "";
  $("#as-of").textContent = `Data as of ${data.as_of_label} (U.S. market close)${liveNote}`;

  const histSpec = [
    ["previous_close", "Previous close"],
    ["week_ago", "1 week ago"],
    ["month_ago", "1 month ago"],
  ];
  $("#history").innerHTML = histSpec
    .map(([key, title]) => {
      const h = data.history?.[key];
      if (!h) return `<article class="hist-card"><div class="kicker">${title}</div><div class="num">—</div></article>`;
      const delta = data.score - h.score;
      const arrow = delta === 0 ? "unchanged" : delta > 0 ? `↑ ${delta} since then` : `↓ ${Math.abs(delta)} since then`;
      return `<article class="hist-card">
        <div class="kicker">${title}</div>
        <div class="num ${zoneClass(h.zone)}">${h.score}</div>
        <div class="meta">${h.label_short} · ${formatDate(h.date)}</div>
        <div class="delta">${arrow}</div>
      </article>`;
    })
    .join("");

  $("#components").innerHTML =
    `<h2>Components</h2>` +
    data.components
      .map((c) => {
        const left = clamp(c.score);
        return `<article class="comp" id="comp-${c.id}">
          <div class="comp-top">
            <div class="comp-name">${c.name}</div>
            <div class="comp-score ${zoneClass(zoneFor(c.score).id)}">${Number(c.score).toFixed(1)}</div>
          </div>
          <div class="comp-value">${c.value_label}</div>
          <div class="bar" aria-hidden="true"><span class="bar-marker" style="left:${reduceMotion ? left : 0}%"></span></div>
          <p class="comp-desc">${c.description}</p>
        </article>`;
      })
      .join("");

  drawSpark(data.series || []);

  // Source in methodology
  const src = $("#source-line");
  if (src) {
    src.innerHTML = `Prices from <a href="https://finance.yahoo.com/quote/NVDA/" rel="noopener" target="_blank">Yahoo Finance</a> daily bars${data.live ? " (fetched live in this browser)" : " (cached after the U.S. close)"}.`;
  }

  animateTo(data.score);

  if (!reduceMotion) {
    requestAnimationFrame(() => {
      document.querySelectorAll(".bar-marker").forEach((el, i) => {
        const c = data.components[i];
        if (c) el.style.left = `${clamp(c.score)}%`;
      });
    });
  }

  // Expose for tests
  window.__INDEX__ = data;
}

async function main() {
  try {
    const data = await loadIndex();
    render(data);
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `<div class="error"><p>Could not load the index.</p><p>${String(err.message || err)}</p></div>`;
    document.documentElement.dataset.ready = "1";
  }
}

main();
