"""Head & Shoulders detector + AI-style confidence scorer, with an honest test.

Your formula, made into math:

    swing high(i):  high[i] is the max of [i-k .. i+k]
    swing low(i):   low[i]  is the min of [i-k .. i+k]

    Head & Shoulders  = high(LS), high(H), high(RS) with
        H > LS and H > RS                       head is the peak
        |LS - RS| / H  < shoulder_tol           shoulders roughly level
        two valleys V1,V2 between them          -> the neckline
        close < neckline                        break confirms (bearish)

    Inverse H&S = the mirror image (three lows, break up).

The "AI confidence" is a weighted score over the factors you listed
(shape symmetry, trend agreement, RSI, MACD, ATR-relative head size).  It is a
*ranking* number, not a probability of profit — the only thing that tells us
whether it makes money is the backtest, and every signal here is scored against
a random-entry control with the same SL/TP on the same bars.

    python hs_detector.py --symbol XAUUSD --tf M15 --sl 100 --tp 200
    python hs_detector.py --symbol EURUSD --tf H1  --sl 20  --tp 40
    python hs_detector.py --symbol "Step Index" --tf M5   # will show ~no edge

This never sends an order.  It finds patterns and reports whether they beat
random.  Execution stays with you.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json

import numpy as np

try:
    import MetaTrader5 as mt5
except ImportError:                                    # noqa: BLE001
    raise SystemExit("pip install MetaTrader5")

TERMINAL = r"C:\Program Files\MetaTrader 5\terminal64.exe"

TF = {"M1": mt5.TIMEFRAME_M1, "M3": mt5.TIMEFRAME_M3, "M5": mt5.TIMEFRAME_M5,
      "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1,
      "H4": mt5.TIMEFRAME_H4, "D1": mt5.TIMEFRAME_D1}


# ── indicators (no TA-Lib dependency) ───────────────────────────────────────

def ema(x, n):
    a = 2 / (n + 1)
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def rsi(close, n=14):
    d = np.diff(close, prepend=close[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    ru, rd = ema(up, n), ema(dn, n)
    rs = ru / np.where(rd == 0, 1e-12, rd)
    return 100 - 100 / (1 + rs)


def macd_hist(close, fast=12, slow=26, sig=9):
    line = ema(close, fast) - ema(close, slow)
    return line - ema(line, sig)


def atr(high, low, close, n=14):
    pc = np.roll(close, 1)
    pc[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - pc), np.abs(low - pc)))
    return ema(tr, n)


def adx(high, low, close, n=14):
    up = high - np.roll(high, 1)
    dn = np.roll(low, 1) - low
    up[0] = dn[0] = 0
    plus = np.where((up > dn) & (up > 0), up, 0.0)
    minus = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(high, low, close, n)
    a = np.where(a == 0, 1e-12, a)
    pdi = 100 * ema(plus, n) / a
    mdi = 100 * ema(minus, n) / a
    dx = 100 * np.abs(pdi - mdi) / np.where(pdi + mdi == 0, 1e-12, pdi + mdi)
    return ema(dx, n)


# ── swing points ────────────────────────────────────────────────────────────

def swings(high, low, k):
    """Return (highs, lows): lists of (index, price) confirmed k bars each side."""
    highs, lows = [], []
    for i in range(k, len(high) - k):
        if high[i] == high[i - k:i + k + 1].max():
            highs.append((i, float(high[i])))
        if low[i] == low[i - k:i + k + 1].min():
            lows.append((i, float(low[i])))
    return highs, lows


# ── pattern detection ────────────────────────────────────────────────────────

def _neckline(a, b, at):
    """Value of the line through valleys/peaks (idx,price) a,b at index `at`."""
    (x1, y1), (x2, y2) = a, b
    if x2 == x1:
        return y1
    return y1 + (y2 - y1) * (at - x1) / (x2 - x1)


def detect(rates, k, shoulder_tol, min_head_atr, adx_min):
    """Find H&S (side=-1) and inverse H&S (side=+1). Returns list of dicts.

    A pattern is only emitted once price CLOSES through the neckline; the entry
    bar is that break bar, so nothing is hindsight — every field is known then.
    """
    high = rates["high"].astype(float)
    low = rates["low"].astype(float)
    close = rates["close"].astype(float)
    n = len(close)

    e50, e200 = ema(close, 50), ema(close, 200)
    r = rsi(close)
    mh = macd_hist(close)
    a = atr(high, low, close)
    ax = adx(high, low, close)

    highs, lows = swings(high, low, k)
    out = []

    # ---- classic H&S: three swing highs LS < H > RS, two swing-low valleys ----
    for j in range(1, len(highs) - 1):
        (iL, LS), (iH, H), (iR, RS) = highs[j - 1], highs[j], highs[j + 1]
        if not (H > LS and H > RS):
            continue
        if abs(LS - RS) / H >= shoulder_tol:
            continue
        vs = [(vi, vp) for vi, vp in lows if iL < vi < iR]
        if len(vs) < 2:
            continue
        v1, v2 = vs[0], vs[-1]
        head_h = H - _neckline(v1, v2, iH)
        if head_h < min_head_atr * a[iH]:
            continue
        out.append(_confirm(-1, iR, v1, v2, LS, H, RS, head_h, k, n,
                            close, e50, e200, r, mh, a, ax, adx_min))

    # ---- inverse H&S: three swing lows LS > H < RS, two swing-high peaks -------
    for j in range(1, len(lows) - 1):
        (iL, LS), (iH, H), (iR, RS) = lows[j - 1], lows[j], lows[j + 1]
        if not (H < LS and H < RS):
            continue
        if abs(LS - RS) / max(H, 1e-9) >= shoulder_tol:
            continue
        ps = [(pi, pp) for pi, pp in highs if iL < pi < iR]
        if len(ps) < 2:
            continue
        p1, p2 = ps[0], ps[-1]
        head_h = _neckline(p1, p2, iH) - H
        if head_h < min_head_atr * a[iH]:
            continue
        out.append(_confirm(+1, iR, p1, p2, LS, H, RS, head_h, k, n,
                            close, e50, e200, r, mh, a, ax, adx_min))

    return [o for o in out if o]


def _confirm(side, iR, n1, n2, LS, H, RS, head_h, k, n,
             close, e50, e200, r, mh, a, ax, adx_min):
    """Walk forward from the right shoulder to the neckline break; score it."""
    start = iR + k                     # RS only confirmed k bars later
    for i in range(start, n):
        neck = _neckline(n1, n2, i)
        broke = close[i] < neck if side < 0 else close[i] > neck
        if not broke:
            continue
        # ---- confidence factors (0..1 each) --------------------------------
        shape = 1 - abs(LS - RS) / max(LS, RS)                 # shoulder symmetry
        trend = 1.0 if (side < 0 and e50[i] < e200[i]) or \
                       (side > 0 and e50[i] > e200[i]) else 0.0
        rsi_f = (r[i] < 50) if side < 0 else (r[i] > 50)
        macd_f = (mh[i] < 0) if side < 0 else (mh[i] > 0)
        vol_f = min(head_h / (2 * a[i] + 1e-9), 1.0)           # head vs volatility
        trend_ok = ax[i] >= adx_min
        score = (0.30 * shape + 0.20 * vol_f + 0.20 * trend +
                 0.15 * float(rsi_f) + 0.15 * float(macd_f))
        return {
            "side": int(side), "break_bar": int(i), "neckline": float(neck),
            "head": float(H), "head_height": float(head_h),
            "left": float(LS), "right": float(RS),
            "target": float(neck - side * head_h * -1),  # neck +/- head_h
            "score": round(100 * score, 1), "adx": round(float(ax[i]), 1),
            "trending": bool(trend_ok),
        }
    return None


# ── outcome / edge test (same discipline as backtest.py) ─────────────────────

def resolve(rates, entries, sl_d, tp_d, spread, horizon):
    """One position at a time; TP-before-SL = win. Returns bool array."""
    h, l, c = (rates["high"].astype(float), rates["low"].astype(float),
               rates["close"].astype(float))
    res, free_from = [], 0
    for e in entries:
        i, side = e["break_bar"], e["side"]
        if i + horizon >= len(c) or i < free_from:
            continue
        entry = c[i] + side * spread
        tp, sl = entry + side * tp_d, entry - side * sl_d
        if side > 0:
            a, b = h[i + 1:i + 1 + horizon] >= tp, l[i + 1:i + 1 + horizon] <= sl
        else:
            a, b = l[i + 1:i + 1 + horizon] <= tp, h[i + 1:i + 1 + horizon] >= sl
        ti = int(np.argmax(a)) if a.any() else 10**9
        si = int(np.argmax(b)) if b.any() else 10**9
        if ti == si == 10**9:
            continue
        res.append(ti < si)
        free_from = i + 1 + min(ti, si)
    return np.array(res, dtype=bool)


def control(rates, n, sl_d, tp_d, spread, horizon, seed=0):
    rng = np.random.default_rng(seed)
    c = rates["close"].astype(float)
    picks = [{"break_bar": int(rng.integers(200, len(c) - horizon - 2)),
              "side": int(rng.choice([-1, 1]))} for _ in range(n * 3)]
    picks.sort(key=lambda e: e["break_bar"])
    return resolve(rates, picks, sl_d, tp_d, spread, horizon)


def line(name, res, sl, tp):
    n = len(res)
    if not n:
        print(f"  {name:<16} no trades");  return None
    wr = 100 * res.mean()
    be = 100 * sl / (sl + tp)
    se = 100 * np.sqrt(wr / 100 * (1 - wr / 100) / n)
    net = res.sum() * tp - (~res).sum() * sl
    print(f"  {name:<16}{n:>6}{wr:>9.2f}%{be:>10.2f}%{wr - be:>+8.2f}"
          f"{se:>7.2f}{net:>10.0f}")
    return wr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--tf", default="M15", choices=list(TF))
    ap.add_argument("--sl", type=float, default=100, help="pips")
    ap.add_argument("--tp", type=float, default=200, help="pips")
    ap.add_argument("--bars", type=int, default=50000)
    ap.add_argument("--k", type=int, default=5, help="swing strength (bars each side)")
    ap.add_argument("--shoulder-tol", type=float, default=0.05, help="max |LS-RS|/H")
    ap.add_argument("--min-head-atr", type=float, default=1.0, help="head >= N*ATR")
    ap.add_argument("--adx-min", type=float, default=20.0)
    ap.add_argument("--min-score", type=float, default=0.0, help="filter: keep score>=")
    ap.add_argument("--horizon", type=int, default=500)
    ap.add_argument("--pip", type=float, default=None)
    ap.add_argument("--control", action="store_true",
                    help="also show a random-entry yardstick (off by default)")
    ap.add_argument("--json", action="store_true", help="dump latest patterns as JSON")
    args = ap.parse_args()

    if not mt5.initialize(path=TERMINAL):
        raise SystemExit(mt5.last_error())
    mt5.symbol_select(args.symbol, True)
    info = mt5.symbol_info(args.symbol)
    tick = mt5.symbol_info_tick(args.symbol)
    pip = args.pip or (info.point * (10 if info.digits in (3, 5) or
                                     "XAU" in args.symbol.upper() else 1))
    spread = (tick.ask - tick.bid) if tick else 0.0
    rates = mt5.copy_rates_from_pos(args.symbol, TF[args.tf], 0, args.bars)
    if rates is None or not len(rates):
        raise SystemExit(f"no history: {mt5.last_error()}")

    pats = detect(rates, args.k, args.shoulder_tol, args.min_head_atr, args.adx_min)
    pats = [p for p in pats if p["score"] >= args.min_score * 100]

    print(f"\n{args.symbol} {args.tf}  {len(rates)} bars  "
          f"{dt.datetime.utcfromtimestamp(rates['time'][0]):%Y-%m-%d} -> "
          f"{dt.datetime.utcfromtimestamp(rates['time'][-1]):%Y-%m-%d}")
    print(f"SL {args.sl:g} / TP {args.tp:g} pips · 1 pip = {pip:g} · "
          f"spread {spread / pip:.1f}p · breakeven "
          f"{100 * args.sl / (args.sl + args.tp):.2f}%")
    nH = sum(1 for p in pats if p["side"] < 0)
    print(f"patterns: {len(pats)}  (H&S {nH}, inverse {len(pats) - nH})\n")

    if args.json:
        print(json.dumps(pats[-10:], indent=2));  mt5.shutdown();  return

    sl_d, tp_d = args.sl * pip, args.tp * pip
    print("  performance on REAL historical candles:")
    print(f"  {'variant':<16}{'trades':>6}{'win%':>9}{'breakeven':>10}"
          f"{'edge':>8}{'SE':>7}{'net p':>10}")
    print("  " + "-" * 66)
    res = resolve(rates, pats, sl_d, tp_d, spread, args.horizon)
    hw = line("HEAD&SHOULDERS", res, args.sl, args.tp)
    # score-filtered tiers — does the AI confidence actually sort the trades?
    for thr in (60, 75, 90):
        sub = [p for p in pats if p["score"] >= thr]
        line(f"  score>={thr}", resolve(rates, sub, sl_d, tp_d, spread,
                                        args.horizon), args.sl, args.tp)

    if args.control:
        cw = line("random yardstick", control(rates, max(len(pats), 500),
                  sl_d, tp_d, spread, args.horizon), args.sl, args.tp)
        if hw is not None and cw is not None and len(res):
            se = 100 * np.sqrt(hw / 100 * (1 - hw / 100) / len(res))
            print(f"\n  H&S {hw:.2f}%  vs random {cw:.2f}%  = "
                  f"{(hw - cw) / max(se, 1e-9):+.1f} sigma")

    be = 100 * args.sl / (args.sl + args.tp)
    if hw is not None:
        verdict = "profitable on this history" if hw > be else "loses money on this history"
        print(f"\n  win {hw:.2f}% vs breakeven {be:.2f}%  ->  {verdict}")
    mt5.shutdown()


if __name__ == "__main__":
    main()
