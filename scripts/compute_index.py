#!/usr/bin/env python3
"""Compute the NVIDIA Erection Index from public NVDA daily prices.

Primary source: Yahoo Finance chart API (query1, then query2).
Writes docs/data/index.json. Never invents prices.
"""

from __future__ import annotations

import json
import math
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "docs" / "data" / "index.json"

YAHOO_URLS = [
    "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=2y&interval=1d&events=history",
    "https://query2.finance.yahoo.com/v8/finance/chart/NVDA?range=2y&interval=1d&events=history",
]

UA = (
    "Mozilla/5.0 (compatible; NVDA-Erection-Index/1.0; "
    "+https://piyaster11.github.io/nvda-erection-index/)"
)
NY = ZoneInfo("America/New_York")

# Lookbacks (trading days)
MA_WINDOW = 125
RSI_WINDOW = 14
VOL_SHORT = 20
VOL_LONG = 252
HIGH_LOW_WINDOW = 252  # ~52 weeks
RET_SHORT = 5
RET_MEDIUM = 20

# tanh scales: the move that maps to roughly 76 / 24 on the 0-100 scale
MOMENTUM_SCALE = 0.20  # 20% above/below the 125-day MA
RET5_SCALE = 0.08  # 8% in 5 sessions
RET20_SCALE = 0.15  # 15% in 20 sessions
VOL_RATIO_SCALE = 0.40  # vol20/vol252 deviation of 0.4 from 1.0


def clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def tanh_score(x: float, scale: float) -> float:
    """Map a signed value onto 0-100, with 50 at 0."""
    return 50.0 + 50.0 * math.tanh(x / scale)


def zone_for(score: float) -> dict[str, Any]:
    # CNN-style bins: 0-24, 25-44, 45-55, 56-75, 76-100
    s = int(round(score))
    if s < 25:
        return {
            "id": "limp",
            "label": "Limp / Extreme Fear",
            "label_short": "Limp",
        }
    if s < 45:
        return {
            "id": "fear",
            "label": "Half-mast / Fear",
            "label_short": "Half-mast",
        }
    if s < 56:
        return {
            "id": "neutral",
            "label": "Neutral",
            "label_short": "Neutral",
        }
    if s < 76:
        return {
            "id": "greed",
            "label": "Rising / Greed",
            "label_short": "Rising",
        }
    return {
        "id": "extreme_greed",
        "label": "Rock Hard / Extreme Greed",
        "label_short": "Rock Hard",
    }


def fetch_yahoo() -> tuple[dict[str, Any], str]:
    last_err: Exception | None = None
    for url in YAHOO_URLS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read()
                    data = json.loads(raw.decode("utf-8"))
                if data.get("chart", {}).get("error"):
                    raise RuntimeError(f"Yahoo chart error: {data['chart']['error']}")
                if not data.get("chart", {}).get("result"):
                    raise RuntimeError("Yahoo chart returned no result")
                return data, url
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
                last_err = exc
                time.sleep(1.5 * (attempt + 1))
        # try next host
    raise RuntimeError(f"Failed to fetch NVDA prices from Yahoo Finance: {last_err}")


def parse_bars(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = payload["chart"]["result"][0]
    ts = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    adj_list = (result["indicators"].get("adjclose") or [{}])[0].get("adjclose") or []
    opens, highs, lows, closes = quote["open"], quote["high"], quote["low"], quote["close"]
    bars: list[dict[str, Any]] = []
    for i, t in enumerate(ts):
        close = closes[i]
        adj = adj_list[i] if i < len(adj_list) else None
        high = highs[i]
        low = lows[i]
        if close is None or high is None or low is None:
            continue
        price = float(adj) if adj is not None else float(close)
        dt = datetime.fromtimestamp(t, tz=timezone.utc).astimezone(NY)
        bars.append(
            {
                "date": dt.strftime("%Y-%m-%d"),
                "timestamp": int(t),
                "open": None if opens[i] is None else float(opens[i]),
                "high": float(high),
                "low": float(low),
                "close": float(close),
                "price": price,  # split/div adjusted, used for all calculations
            }
        )
    if len(bars) < VOL_LONG + RET_MEDIUM + 5:
        raise RuntimeError(f"Not enough daily bars to compute the index ({len(bars)}).")
    return bars


def wilder_rsi(prices: list[float], period: int = RSI_WINDOW) -> list[float | None]:
    n = len(prices)
    out: list[float | None] = [None] * n
    if n <= period:
        return out
    gains = []
    losses = []
    for i in range(1, period + 1):
        ch = prices[i] - prices[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_gain = mean(gains)
    avg_loss = mean(losses)
    if avg_loss == 0 and avg_gain == 0:
        out[period] = 50.0
    elif avg_loss == 0:
        out[period] = 100.0
    else:
        out[period] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period + 1, n):
        ch = prices[i] - prices[i - 1]
        gain = max(ch, 0.0)
        loss = max(-ch, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0 and avg_gain == 0:
            out[i] = 50.0
        elif avg_loss == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def rolling_mean(values: list[float], window: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < window:
        return out
    acc = sum(values[:window])
    out[window - 1] = acc / window
    for i in range(window, len(values)):
        acc += values[i] - values[i - window]
        out[i] = acc / window
    return out


def daily_returns(prices: list[float]) -> list[float | None]:
    out: list[float | None] = [None]
    for i in range(1, len(prices)):
        if prices[i - 1] == 0:
            out.append(None)
        else:
            out.append(prices[i] / prices[i - 1] - 1.0)
    return out


def rolling_std(values: list[float | None], window: int, end: int) -> float | None:
    """Sample-like population stdev of the last `window` non-null values ending at end (inclusive)."""
    chunk: list[float] = []
    i = end
    while i >= 0 and len(chunk) < window:
        v = values[i]
        if v is not None:
            chunk.append(v)
        i -= 1
    if len(chunk) < window:
        return None
    return pstdev(chunk)


def range_high_low(highs: list[float], lows: list[float], end: int, window: int) -> tuple[float, float] | None:
    start = end - window + 1
    if start < 0:
        return None
    return max(highs[start : end + 1]), min(lows[start : end + 1])


def components_at(
    i: int,
    prices: list[float],
    highs: list[float],
    lows: list[float],
    ma125: list[float | None],
    rsi: list[float | None],
    rets: list[float | None],
) -> dict[str, Any] | None:
    price = prices[i]
    ma = ma125[i]
    rsi_v = rsi[i]
    if ma is None or ma == 0 or rsi_v is None:
        return None
    if i < RET_MEDIUM:
        return None
    hl = range_high_low(highs, lows, i, HIGH_LOW_WINDOW)
    vol20 = rolling_std(rets, VOL_SHORT, i)
    vol1y = rolling_std(rets, VOL_LONG, i)
    if hl is None or vol20 is None or vol1y is None or vol1y == 0:
        return None

    high52, low52 = hl
    mom_pct = price / ma - 1.0
    momentum = clamp(tanh_score(mom_pct, MOMENTUM_SCALE))

    rsi_score = clamp(rsi_v)

    span = high52 - low52
    if span <= 0:
        range_score = 50.0
        range_pos = 0.5
    else:
        range_pos = (price - low52) / span
        range_score = clamp(range_pos * 100.0)

    vol_ratio = vol20 / vol1y
    vol_score = clamp(tanh_score(1.0 - vol_ratio, VOL_RATIO_SCALE))

    ret5 = price / prices[i - RET_SHORT] - 1.0
    ret20 = price / prices[i - RET_MEDIUM] - 1.0
    ret_score = clamp((tanh_score(ret5, RET5_SCALE) + tanh_score(ret20, RET20_SCALE)) / 2.0)

    parts = [
        {
            "id": "momentum",
            "name": "Price vs 125-day MA",
            "description": "How far the adjusted close sits above or below its 125-session moving average.",
            "raw": mom_pct,
            "value_label": f"{mom_pct * 100:+.1f}% vs 125-day MA",
            "ma": ma,
            "score": momentum,
        },
        {
            "id": "rsi",
            "name": "14-day RSI",
            "description": "Wilder relative strength index. High RSI leans greedy; low RSI leans fearful.",
            "raw": rsi_v,
            "value_label": f"{rsi_v:.1f}",
            "score": rsi_score,
        },
        {
            "id": "range",
            "name": "52-week high / low",
            "description": "Where the latest close sits between the 52-week high and low (using daily highs and lows).",
            "raw": range_pos,
            "value_label": f"{range_pos * 100:.1f}% of 52-week range",
            "high52": high52,
            "low52": low52,
            "score": range_score,
        },
        {
            "id": "volatility",
            "name": "20-day vs 1-year volatility",
            "description": "Inverse reading: short-term volatility above its 1-year average scores lower (fear); calmer tape scores higher.",
            "raw": vol_ratio,
            "value_label": f"{vol_ratio:.2f}× the 1-year average",
            "vol20": vol20,
            "vol1y": vol1y,
            "score": vol_score,
        },
        {
            "id": "returns",
            "name": "5 / 20-day return",
            "description": "Average of short-term (5-session) and medium-term (20-session) price returns.",
            "raw": {"ret5": ret5, "ret20": ret20},
            "value_label": f"{ret5 * 100:+.1f}% (5d) · {ret20 * 100:+.1f}% (20d)",
            "score": ret_score,
        },
    ]
    score_raw = mean(p["score"] for p in parts)
    z = zone_for(score_raw)
    return {
        "score_raw": score_raw,
        "score": int(round(score_raw)),
        **z,
        "price": price,
        "components": parts,
    }


def snapshot(bars: list[dict[str, Any]], i: int, computed: dict[str, Any]) -> dict[str, Any]:
    return {
        "date": bars[i]["date"],
        "score": computed["score"],
        "score_raw": round(computed["score_raw"], 2),
        "label": computed["label"],
        "label_short": computed["label_short"],
        "zone": computed["id"],
        "price": round(computed["price"], 4),
        "close": round(bars[i]["close"], 4),
    }


def build_payload(bars: list[dict[str, Any]], source_url: str) -> dict[str, Any]:
    prices = [b["price"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    ma125 = rolling_mean(prices, MA_WINDOW)
    rsi = wilder_rsi(prices, RSI_WINDOW)
    rets = daily_returns(prices)

    series: list[dict[str, Any]] = []
    by_index: dict[int, dict[str, Any]] = {}
    for i in range(len(bars)):
        c = components_at(i, prices, highs, lows, ma125, rsi, rets)
        if c is None:
            continue
        by_index[i] = c
        series.append(
            {
                "date": bars[i]["date"],
                "score": c["score"],
                "score_raw": round(c["score_raw"], 2),
                "price": round(bars[i]["close"], 4),
                "label_short": c["label_short"],
                "zone": c["id"],
            }
        )

    if not by_index:
        raise RuntimeError("Could not compute a single daily score — not enough history.")

    last_i = max(by_index)
    current = by_index[last_i]
    last_bar = bars[last_i]
    prev_i = last_i - 1 if (last_i - 1) in by_index else None
    week_i = last_i - 5 if (last_i - 5) in by_index else None
    month_i = last_i - 21 if (last_i - 21) in by_index else None

    prev_price = bars[last_i - 1]["close"] if last_i > 0 else None
    change = last_bar["close"] - prev_price if prev_price is not None else None
    change_pct = (change / prev_price * 100.0) if prev_price else None

    def hist(i: int | None) -> dict[str, Any] | None:
        if i is None:
            return None
        return snapshot(bars, i, by_index[i])

    # Round component scores for the public payload but keep two decimals
    public_components = []
    for p in current["components"]:
        item = {
            "id": p["id"],
            "name": p["name"],
            "description": p["description"],
            "value_label": p["value_label"],
            "score": round(p["score"], 1),
        }
        if p["id"] == "momentum":
            item["ma125"] = round(p["ma"], 4)
            item["pct_vs_ma"] = round(p["raw"] * 100, 2)
        elif p["id"] == "rsi":
            item["rsi"] = round(p["raw"], 2)
        elif p["id"] == "range":
            item["high52"] = round(p["high52"], 4)
            item["low52"] = round(p["low52"], 4)
            item["range_pct"] = round(p["raw"] * 100, 2)
        elif p["id"] == "volatility":
            item["ratio"] = round(p["raw"], 3)
            item["vol20"] = round(p["vol20"] * 100, 3)  # daily % stdev
            item["vol1y"] = round(p["vol1y"] * 100, 3)
        elif p["id"] == "returns":
            item["ret5_pct"] = round(p["raw"]["ret5"] * 100, 2)
            item["ret20_pct"] = round(p["raw"]["ret20"] * 100, 2)
        public_components.append(item)

    as_of = last_bar["date"]
    as_of_dt = datetime.strptime(as_of, "%Y-%m-%d")
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "symbol": "NVDA",
        "name": "NVIDIA Erection Index",
        "source": "Yahoo Finance",
        "source_url": source_url,
        "as_of": as_of,
        "as_of_label": as_of_dt.strftime("%B ") + str(as_of_dt.day) + as_of_dt.strftime(", %Y"),
        "timezone": "America/New_York",
        "generated_at": generated,
        "price": round(last_bar["close"], 4),
        "prev_close_price": None if prev_price is None else round(prev_price, 4),
        "change": None if change is None else round(change, 4),
        "change_pct": None if change_pct is None else round(change_pct, 2),
        "score": current["score"],
        "score_raw": round(current["score_raw"], 2),
        "label": current["label"],
        "label_short": current["label_short"],
        "zone": current["id"],
        "components": public_components,
        "history": {
            "previous_close": hist(prev_i),
            "week_ago": hist(week_i),
            "month_ago": hist(month_i),
        },
        "series": series,
        "methodology": {
            "weights": "Equal average of five components, each scaled to 0–100.",
            "momentum": "Percent distance from the 125-day moving average, mapped with a tanh scale of 20%.",
            "rsi": "14-day Wilder RSI used directly as the 0–100 sub-score.",
            "range": "Close position between the 52-week high and low (daily highs/lows over 252 sessions).",
            "volatility": "Ratio of 20-day to 252-day standard deviation of daily returns, inverted (calmer = higher score) with a tanh scale of 0.40 around a ratio of 1.0.",
            "returns": "Average of 5-session and 20-session returns, tanh-mapped with scales of 8% and 15%.",
            "zones": [
                {"min": 0, "max": 24, "id": "limp", "label": "Limp / Extreme Fear"},
                {"min": 25, "max": 44, "id": "fear", "label": "Half-mast / Fear"},
                {"min": 45, "max": 55, "id": "neutral", "label": "Neutral"},
                {"min": 56, "max": 75, "id": "greed", "label": "Rising / Greed"},
                {"min": 76, "max": 100, "id": "extreme_greed", "label": "Rock Hard / Extreme Greed"},
            ],
        },
        "disclaimer": "For fun, not financial advice.",
    }


def main() -> int:
    payload_yahoo, url = fetch_yahoo()
    bars = parse_bars(payload_yahoo)
    data = build_payload(bars, url)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(OUT_PATH)
    print(
        f"Wrote {OUT_PATH}  as_of={data['as_of']}  "
        f"price={data['price']}  score={data['score']} ({data['label']})",
        file=sys.stderr,
    )
    for c in data["components"]:
        print(f"  {c['id']:12} {c['score']:6.1f}  {c['value_label']}", file=sys.stderr)
    hist = data["history"]
    for key in ("previous_close", "week_ago", "month_ago"):
        h = hist[key]
        if h:
            print(f"  {key:16} {h['date']}  score={h['score']}  price={h['close']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
