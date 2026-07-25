"""Strategy backtester for MetaTrader 5 history.

The point of this tool is one number: **edge over the random baseline**.

A reward:risk ratio does not create an edge.  For any SL/TP pair, a driftless
market hits TP first about ``SL / (SL + TP)`` of the time — so a 1:3 ratio
"needs only 25%" precisely because 25% is what a coin flip already gives you.
Every strategy here is therefore scored against that baseline *and* against a
random-entry control run on the same bars, with the same costs.

A rule is only worth trading if it beats both, by more than the spread, out of
sample.

Usage
-----
    python backtest.py --symbol "Step Index" --tf M1 --sl 10 --tp 30
    python backtest.py --symbol XAUUSD --tf M5 --sl 100 --tp 300 --rule ma_cross
    python backtest.py --list-rules
"""

from __future__ import annotations

import argparse
import datetime as dt

import numpy as np

try:
    import MetaTrader5 as mt5
except ImportError:                                    # noqa: BLE001
    raise SystemExit("MetaTrader5 package required: pip install MetaTrader5")

TERMINAL = r"C:\Program Files\MetaTrader 5\terminal64.exe"

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


# ── data ──────────────────────────────────────────────────────────────────

def load(symbol: str, timeframe: str, bars: int):
    if not mt5.initialize(path=TERMINAL):
        raise SystemExit(f"MT5 initialize failed: {mt5.last_error()}")
    if not mt5.symbol_select(symbol, True):
        raise SystemExit(f"unknown symbol {symbol!r}")
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)

    rates = None
    for n in (bars, 50000, 20000, 5000):               # terminal caps the request
        rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[timeframe], 0, n)
        if rates is not None and len(rates):
            break
    if rates is None or not len(rates):
        raise SystemExit(f"no history for {symbol} {timeframe}: {mt5.last_error()}")

    # Pip size is per-symbol convention, not something to guess: on Step Index
    # one pip is one point (0.1), on XAUUSD it is ten points ($0.10).  Getting
    # this wrong silently rescales SL/TP by 10x, so it is printed and can be
    # overridden with --pip.
    pip = info.point * (10 if info.digits in (3, 5) or "XAU" in symbol.upper()
                        else 1)
    spread = (tick.ask - tick.bid) if tick else info.spread * info.point
    return rates, info, pip, spread


# ── entry rules ───────────────────────────────────────────────────────────
# Each returns an int array of -1 (sell), 0 (stand aside) or +1 (buy) per bar.

def rule_random(c, h, l, rng, **_):
    """Control: enter blindly. Every real rule must beat this."""
    return rng.choice([-1, 1], size=len(c))


def rule_always_buy(c, h, l, **_):
    return np.ones(len(c), dtype=int)


def rule_ma_cross(c, h, l, fast=9, slow=21, **_):
    """Long while the fast SMA is above the slow, short while below."""
    def sma(x, n):
        out = np.full(len(x), np.nan)
        cs = np.cumsum(np.insert(x, 0, 0.0))
        out[n - 1:] = (cs[n:] - cs[:-n]) / n
        return out
    f, s = sma(c, fast), sma(c, slow)
    sig = np.zeros(len(c), dtype=int)
    sig[f > s] = 1
    sig[f < s] = -1
    sig[np.isnan(f) | np.isnan(s)] = 0
    return sig


def rule_breakout(c, h, l, lookback=20, **_):
    """Buy a break of the prior N-bar high, sell a break of the low."""
    sig = np.zeros(len(c), dtype=int)
    for i in range(lookback, len(c)):
        if c[i] > h[i - lookback:i].max():
            sig[i] = 1
        elif c[i] < l[i - lookback:i].min():
            sig[i] = -1
    return sig


def rule_mean_revert(c, h, l, lookback=20, z=2.0, **_):
    """Fade stretches: buy when far below the mean, sell when far above."""
    sig = np.zeros(len(c), dtype=int)
    for i in range(lookback, len(c)):
        w = c[i - lookback:i]
        sd = w.std()
        if sd == 0:
            continue
        dev = (c[i] - w.mean()) / sd
        if dev <= -z:
            sig[i] = 1
        elif dev >= z:
            sig[i] = -1
    return sig


def rule_bos_retest(c, h, l, left=3, right=3, wait=30, tol_pips=3.0, pip=0.1, **_):
    """Break of structure, then retest — the rule as described.

    A swing high is a bar whose high tops the ``left`` bars before and ``right``
    bars after it.  Critically it is only *known* ``right`` bars later, so it is
    not usable until then: treating a swing as visible on the bar it forms is
    lookahead bias and is the usual reason a backtest of this pattern looks
    profitable when the live version is not.

    When close breaks the last confirmed swing high, the setup arms.  Entry is
    on a pullback that touches back within ``tol_pips`` of the broken level
    while closing back on the breakout side, inside ``wait`` bars.
    """
    n = len(c)
    sig = np.zeros(n, dtype=int)
    tol = tol_pips * pip

    # Confirmed swing levels, each usable only from `right` bars after it forms.
    swing_hi = np.full(n, np.nan)
    swing_lo = np.full(n, np.nan)
    for i in range(left, n - right):
        w_h = h[i - left:i + right + 1]
        w_l = l[i - left:i + right + 1]
        if h[i] == w_h.max():
            swing_hi[i + right] = h[i]
        if l[i] == w_l.min():
            swing_lo[i + right] = l[i]

    last_hi = last_lo = np.nan
    armed = None            # ('long'|'short', level, bar_armed)
    for i in range(n):
        if not np.isnan(swing_hi[i]):
            last_hi = swing_hi[i]
        if not np.isnan(swing_lo[i]):
            last_lo = swing_lo[i]

        if armed is not None:
            side, level, at = armed
            if i - at > wait:
                armed = None
            elif side == "long" and l[i] <= level + tol and c[i] > level:
                sig[i] = 1
                armed = None
            elif side == "short" and h[i] >= level - tol and c[i] < level:
                sig[i] = -1
                armed = None

        if armed is None:
            if not np.isnan(last_hi) and c[i] > last_hi:
                armed = ("long", last_hi, i)
                last_hi = np.nan          # consume the level
            elif not np.isnan(last_lo) and c[i] < last_lo:
                armed = ("short", last_lo, i)
                last_lo = np.nan
    return sig


def _ema(x, n):
    a = 2 / (n + 1)
    out = np.empty(len(x))
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def _rsi(c, n=14):
    d = np.diff(c, prepend=c[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    ru = _ema(up, n)
    rd = _ema(dn, n)
    rs = ru / np.where(rd == 0, 1e-9, rd)
    return 100 - 100 / (1 + rs)


def _stoch(h, l, c, n=14):
    k = np.full(len(c), 50.0)
    for i in range(n, len(c)):
        lo = l[i - n:i + 1].min()
        hi = h[i - n:i + 1].max()
        k[i] = 50.0 if hi == lo else 100 * (c[i] - lo) / (hi - lo)
    return k


def rule_ema_stoch(c, h, l, ema=8, **_):
    """The most-cited Deriv scalp: trade with the 8-EMA, time with Stochastic.

    Sell: price below the EMA and Stochastic crosses down out of overbought.
    Buy:  price above the EMA and Stochastic crosses up out of oversold.
    """
    e = _ema(c, ema)
    k = _stoch(h, l, c)
    sig = np.zeros(len(c), dtype=int)
    for i in range(1, len(c)):
        if c[i] < e[i] and k[i - 1] >= 80 and k[i] < 80:
            sig[i] = -1
        elif c[i] > e[i] and k[i - 1] <= 20 and k[i] > 20:
            sig[i] = 1
    return sig


def rule_rsi_revert(c, h, l, n=14, lo=30, hi=70, **_):
    """Classic mean reversion: buy oversold, sell overbought."""
    r = _rsi(c, n)
    sig = np.zeros(len(c), dtype=int)
    for i in range(1, len(c)):
        if r[i - 1] <= lo and r[i] > lo:
            sig[i] = 1
        elif r[i - 1] >= hi and r[i] < hi:
            sig[i] = -1
    return sig


def rule_bollinger(c, h, l, n=20, k=2.0, **_):
    """Fade the bands: buy a close back inside the lower band, sell the upper."""
    sig = np.zeros(len(c), dtype=int)
    for i in range(n, len(c)):
        w = c[i - n:i]
        m, sd = w.mean(), w.std()
        if sd == 0:
            continue
        if c[i - 1] < m - k * sd and c[i] >= m - k * sd:
            sig[i] = 1
        elif c[i - 1] > m + k * sd and c[i] <= m + k * sd:
            sig[i] = -1
    return sig


RULES = {
    "random": rule_random,
    "ema_stoch": rule_ema_stoch,
    "rsi_revert": rule_rsi_revert,
    "bollinger": rule_bollinger,
    "bos_retest": rule_bos_retest,
    "always_buy": rule_always_buy,
    "ma_cross": rule_ma_cross,
    "breakout": rule_breakout,
    "mean_revert": rule_mean_revert,
}


# ── simulation ────────────────────────────────────────────────────────────

def simulate(rates, signals, sl_pips, tp_pips, pip, spread, horizon, step=1):
    """Walk each entry forward bar by bar until SL or TP is touched.

    Where a bar's range covers both levels the loss is taken — the pessimistic
    reading, since intrabar order is unknown and the optimistic one flatters
    every result.
    """
    h = rates["high"].astype(float)
    l = rates["low"].astype(float)
    c = rates["close"].astype(float)
    sl_d, tp_d = sl_pips * pip, tp_pips * pip

    outcomes = []            # +tp_pips or -sl_pips, in pips
    n = len(c) - horizon
    for i in range(0, n, step):
        side = signals[i]
        if side == 0:
            continue
        # Pay the spread on entry: buy at ask, sell at bid.
        entry = c[i] + spread if side > 0 else c[i] - spread
        if side > 0:
            tp, sl = entry + tp_d, entry - sl_d
            hits_tp = h[i + 1:i + 1 + horizon] >= tp
            hits_sl = l[i + 1:i + 1 + horizon] <= sl
        else:
            tp, sl = entry - tp_d, entry + sl_d
            hits_tp = l[i + 1:i + 1 + horizon] <= tp
            hits_sl = h[i + 1:i + 1 + horizon] >= sl

        ti = int(np.argmax(hits_tp)) if hits_tp.any() else 10**9
        si = int(np.argmax(hits_sl)) if hits_sl.any() else 10**9
        if ti == si == 10**9:
            continue                                    # unresolved, discard
        outcomes.append(tp_pips if ti < si else -sl_pips)
    return np.array(outcomes, dtype=float)


def report(name, outcomes, sl_pips, tp_pips, pip_value):
    n = len(outcomes)
    if not n:
        print(f"{name:<14} no trades")
        return None
    wins = int((outcomes > 0).sum())
    wr = 100 * wins / n
    be = 100 * sl_pips / (sl_pips + tp_pips)
    exp_pips = outcomes.mean()
    net = outcomes.sum() * pip_value

    equity = np.cumsum(outcomes)
    drawdown = float((np.maximum.accumulate(equity) - equity).max())

    streak = worst = 0
    for o in outcomes:
        streak = streak + 1 if o < 0 else 0
        worst = max(worst, streak)

    gross_win = outcomes[outcomes > 0].sum()
    gross_loss = -outcomes[outcomes < 0].sum()
    pf = gross_win / gross_loss if gross_loss else float("inf")

    print(f"{name:<14} {n:>6}  {wr:>6.2f}%  {wr - be:>+6.2f}  "
          f"{exp_pips:>+7.3f}  {net:>+10.2f}  {drawdown:>8.0f}  {worst:>5}  {pf:>5.2f}")
    return wr - be


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="Step Index")
    ap.add_argument("--tf", default="M1", choices=list(TIMEFRAMES))
    ap.add_argument("--sl", type=float, default=10, help="stop, in pips")
    ap.add_argument("--tp", type=float, default=30, help="target, in pips")
    ap.add_argument("--bars", type=int, default=50000)
    ap.add_argument("--horizon", type=int, default=1440, help="bars allowed to resolve")
    ap.add_argument("--step", type=int, default=3, help="sample every Nth bar")
    ap.add_argument("--rule", default="all", help="one of RULES, or 'all'")
    ap.add_argument("--lot", type=float, default=None, help="defaults to symbol minimum")
    ap.add_argument("--pip", type=float, default=None,
                    help="price move per pip; overrides the per-symbol default")
    ap.add_argument("--no-spread", action="store_true", help="ignore trading costs")
    ap.add_argument("--list-rules", action="store_true")
    args = ap.parse_args()

    if args.list_rules:
        print("rules:", ", ".join(RULES))
        return

    rates, info, pip, spread = load(args.symbol, args.tf, args.bars)
    if args.pip:
        pip = args.pip
    if args.no_spread:
        spread = 0.0
    lot = args.lot if args.lot is not None else info.volume_min
    # Value of one pip at the traded size.
    pip_value = (info.trade_tick_value / info.trade_tick_size) * pip * lot

    c = rates["close"].astype(float)
    h = rates["high"].astype(float)
    l = rates["low"].astype(float)
    d = np.diff(c)
    autocorr = float(np.corrcoef(d[:-1], d[1:])[0, 1])

    print(f"\n{args.symbol}  {args.tf}  {len(rates)} bars  "
          f"{dt.datetime.utcfromtimestamp(rates['time'][0]):%Y-%m-%d} -> "
          f"{dt.datetime.utcfromtimestamp(rates['time'][-1]):%Y-%m-%d}")
    print(f"SL {args.sl:g} / TP {args.tp:g} pips  |  1 pip = {pip:g} price = "
          f"${pip_value:.3f} at {lot:g} lot  |  spread ${spread:.2f} "
          f"({spread / pip:.1f} pips)")
    print(f"breakeven win rate {100 * args.sl / (args.sl + args.tp):.2f}%  |  "
          f"return autocorrelation {autocorr:+.4f}"
          f"{'  <- memoryless: no entry rule can help' if abs(autocorr) < 0.02 else ''}")
    print(f"\n{'rule':<14} {'trades':>6}  {'win%':>7}  {'edge':>6}  "
          f"{'exp/pip':>7}  {'net $':>10}  {'maxDD':>8}  {'lossR':>5}  {'PF':>5}")
    print("-" * 82)

    rng = np.random.default_rng(7)
    names = list(RULES) if args.rule == "all" else [args.rule]
    for name in names:
        signals = RULES[name](c, h, l, rng=rng, pip=pip)
        outcomes = simulate(rates, signals, args.sl, args.tp, pip, spread,
                            args.horizon, args.step)
        report(name, outcomes, args.sl, args.tp, pip_value)

    print("\nedge  = win% minus breakeven%. Negative means the rule loses money.")
    print("lossR = longest run of consecutive losses. Expect to live through it.")
    print("A rule is only tradable if its edge beats 'random' on the same bars,")
    print("with spread on, and holds up on a period you did not tune it on.")
    mt5.shutdown()


if __name__ == "__main__":
    main()
