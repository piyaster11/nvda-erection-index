# NVIDIA Erection Index

A joke [Fear & Greed](https://edition.cnn.com/markets/fear-and-greed-indexes)-style sentiment gauge for **NVIDIA (NVDA)** stock. The score is 0–100, the zones run from *Limp / Extreme Fear* to *Rock Hard / Extreme Greed*, and the needle is a cartoon arrow.

**Live site:** https://piyaster11.github.io/nvda-erection-index/

**For fun, not financial advice.** This is not an investment recommendation, not a forecast, and not affiliated with NVIDIA Corporation or CNN.

## What’s in the score

The published number is the equal-weight average of five components, each scaled to 0–100, computed from public daily prices (Yahoo Finance chart API). No figures are invented.

| Component | What it measures |
| --- | --- |
| Price vs 125-day MA | Percent distance from the 125-session moving average (tanh-mapped, 20% scale). |
| 14-day RSI | Wilder relative strength index, used directly as the sub-score. |
| 52-week high / low | Close position between the 52-week high and low (252 sessions). |
| 20-day vs 1-year volatility | Ratio of short-term to 1-year daily-return volatility, **inverted** (calmer = higher). |
| 5 / 20-day return | Average of 5-session and 20-session returns (tanh-mapped). |

Zones: **0–24** Limp / Extreme Fear · **25–44** Half-mast / Fear · **45–55** Neutral · **56–75** Rising / Greed · **76–100** Rock Hard / Extreme Greed.

Historical prints for previous close, one week ago, and one month ago use the same formulas on data available up to that session (no look-ahead).

## Data & refresh

- Primary source: [Yahoo Finance](https://finance.yahoo.com/quote/NVDA/) daily bars (`query1` / `query2` chart API, 2-year range).
- A weekday GitHub Action (after the U.S. cash close) runs `scripts/compute_index.py` and, if the reading changed, commits `docs/data/index.json`.
- The page loads that JSON so it works in the browser without a Yahoo CORS request. If a live Yahoo fetch does succeed, the client recomputes with the same formulas.

## Local preview

```bash
python scripts/compute_index.py
python -m http.server 8765 --directory docs
# open http://127.0.0.1:8765/?static=1
```

`?static=1` skips the needle wobble (also honored when the browser asks for reduced motion).

## Hosting

Public GitHub Pages from `main` `/docs`, same pattern as the other sites in this account.

## License

MIT. NVIDIA is a trademark of NVIDIA Corporation. This project is a parody and is not endorsed by NVIDIA or CNN.
