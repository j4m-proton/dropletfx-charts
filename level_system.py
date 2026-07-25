"""Backtest of the level-rejection system from MY-SYSTEM/.

The rules, as read off the TradingView snapshots and confirmed:

  * Horizontal levels come from **30-minute** structure — confirmed swing highs
    and lows.  A level only exists once its swing is confirmed, never before.
  * Execution happens on the **3-minute** chart.
  * A short triggers when price trades up into a level and a candle then
    **closes back below** it (the rejection close).  Longs mirror that.
  * The stop sits just beyond the level — roughly $3 in the snapshots.
  * The target is the **next marked level** in the trade's direction, not a
    fixed pip count.  In the snapshots that produces R:R around 1:20-1:40.

Every result is reported against a control that takes the same number of trades
at random moments with the same stop and target distances, because a big
reward:risk ratio produces a low win rate whether or not there is any edge.
"""

from __future__ import annotations

import argparse
import datetime as dt

import numpy as np

try:
    import MetaTrader5 as mt5
except ImportError:                                    # noqa: BLE001
    raise SystemExit("pip install MetaTrader5")

TERMINAL = r"C:\Program Files\MetaTrader 5\terminal64.exe"
PIP = 0.1                                              # $0.10 per pip on gold


def connect():
    if not mt5.initialize(path=TERMINAL):
        raise SystemExit(f"MT5 init failed: {mt5.last_error()}")


def find_levels(rates, left=5, right=5):
    """Confirmed swing highs/lows -> candidate levels.

    Returned as (confirm_epoch, price, kind).  ``confirm_epoch`` is the time the
    swing became *knowable* — ``right`` bars after it formed — so nothing here
    can be used before it existed on screen.
    """
    h = rates["high"].astype(float)
    l = rates["low"].astype(float)
    t = rates["time"]
    out = []
    for i in range(left, len(h) - right):
        if h[i] == h[i - left:i + right + 1].max():
            out.append((int(t[i + right]), float(h[i]), "high"))
        if l[i] == l[i - left:i + right + 1].min():
            out.append((int(t[i + right]), float(l[i]), "low"))
    out.sort()
    return out


def cluster(levels, tol):
    """Merge levels sitting within ``tol`` of each other.

    Raw pivots produce a level every few bars, which makes "the next level"
    always a few dollars away and collapses the reward:risk to nothing.  A
    trader marks a handful of significant prices, so nearby pivots are folded
    into one and only distinct prices survive.
    """
    if tol <= 0:
        return levels
    kept = []
    for epoch, price, kind in levels:
        for j, (e2, p2, k2) in enumerate(kept):
            if abs(p2 - price) <= tol:
                # keep the earliest confirmation of the cluster
                kept[j] = (min(e2, epoch), (p2 + price) / 2, k2)
                break
        else:
            kept.append((epoch, price, kind))
    kept.sort()
    return kept


def simulate(m3, levels, buffer_usd, min_target_usd, spread, max_hold,
             cooldown_bars=40):
    """Walk the 3-minute series, take every rejection, resolve stop vs target."""
    o = m3["open"].astype(float)
    h = m3["high"].astype(float)
    l = m3["low"].astype(float)
    c = m3["close"].astype(float)
    t = m3["time"]

    trades = []
    li = 0                       # levels become active as time passes
    active: list[tuple[float, str]] = []
    last_used: dict[float, int] = {}

    for i in range(len(c) - 1):
        while li < len(levels) and levels[li][0] <= t[i]:
            active.append((levels[li][1], levels[li][2]))
            li += 1
        if not active:
            continue

        prices = np.array([a[0] for a in active])

        # --- short: traded up into a level, closed back below it -------------
        touched = prices[(h[i] >= prices) & (c[i] < prices) & (o[i] < prices + buffer_usd)]
        if len(touched):
            lvl = float(touched.min())            # nearest level above the close
            if i - last_used.get(lvl, -10**9) > cooldown_bars:
                below = prices[prices < c[i] - min_target_usd]
                if len(below):
                    entry = c[i] - spread          # sell at bid
                    stop = lvl + buffer_usd
                    target = float(below.max())    # next level down
                    trades.append(_resolve(h, l, i, entry, stop, target, -1, max_hold))
                    last_used[lvl] = i

        # --- long: traded down into a level, closed back above it ------------
        touched = prices[(l[i] <= prices) & (c[i] > prices) & (o[i] > prices - buffer_usd)]
        if len(touched):
            lvl = float(touched.max())
            if i - last_used.get(lvl, -10**9) > cooldown_bars:
                above = prices[prices > c[i] + min_target_usd]
                if len(above):
                    entry = c[i] + spread          # buy at ask
                    stop = lvl - buffer_usd
                    target = float(above.min())
                    trades.append(_resolve(h, l, i, entry, stop, target, 1, max_hold))
                    last_used[lvl] = i

    return [x for x in trades if x is not None]


def _resolve(h, l, i, entry, stop, target, side, max_hold):
    """Return (win, risk_usd, reward_usd) or None if it never resolved."""
    risk = abs(entry - stop)
    reward = abs(target - entry)
    if risk <= 0 or reward <= 0:
        return None
    hh = h[i + 1:i + 1 + max_hold]
    ll = l[i + 1:i + 1 + max_hold]
    if side < 0:
        hit_t = ll <= target
        hit_s = hh >= stop
    else:
        hit_t = hh >= target
        hit_s = ll <= stop
    ti = int(np.argmax(hit_t)) if hit_t.any() else 10**9
    si = int(np.argmax(hit_s)) if hit_s.any() else 10**9
    if ti == si == 10**9:
        return None
    # Same-bar ambiguity resolves as a loss — the pessimistic reading.
    return (ti < si, risk, reward)


def control(m3, trades, spread, max_hold, seed=0):
    """Same trade count, same risk/reward geometry, random entry times."""
    rng = np.random.default_rng(seed)
    h = m3["high"].astype(float)
    l = m3["low"].astype(float)
    c = m3["close"].astype(float)
    out = []
    for _, risk, reward in trades:
        for _ in range(20):                        # retry until one resolves
            i = int(rng.integers(100, len(c) - max_hold - 2))
            side = int(rng.choice([-1, 1]))
            entry = c[i] + side * spread
            stop = entry - side * risk
            target = entry + side * reward
            r = _resolve(h, l, i, entry, stop, target, side, max_hold)
            if r is not None:
                out.append(r)
                break
    return out


def report(name, trades):
    n = len(trades)
    if not n:
        print(f"{name:<12} no trades")
        return
    wins = sum(1 for w, _, _ in trades if w)
    wr = 100 * wins / n
    rr = np.mean([rew / rk for _, rk, rew in trades])
    be = 100 / (1 + rr)
    net = sum((rew if w else -rk) for w, rk, rew in trades)
    se = 100 * np.sqrt((wr / 100) * (1 - wr / 100) / n)
    print(f"{name:<12}{n:>7}{wr:>8.2f}%{be:>11.2f}%{wr - be:>+8.2f}{se:>7.2f}"
          f"{rr:>8.1f}{net:>11.2f}{net / n:>10.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--swing", type=int, default=5, help="M30 pivot strength")
    ap.add_argument("--buffer", type=float, default=3.0, help="stop beyond level, $")
    ap.add_argument("--min-target", type=float, default=10.0, help="min distance to next level, $")
    ap.add_argument("--hold", type=int, default=2000, help="max 3-min bars to resolve")
    args = ap.parse_args()

    connect()
    mt5.symbol_select(args.symbol, True)
    tick = mt5.symbol_info_tick(args.symbol)
    spread = (tick.ask - tick.bid) if tick else 0.16

    m30 = mt5.copy_rates_from_pos(args.symbol, mt5.TIMEFRAME_M30, 0, 50000)
    m3 = mt5.copy_rates_from_pos(args.symbol, mt5.TIMEFRAME_M3, 0, 50000)
    if m30 is None or m3 is None:
        raise SystemExit(f"no history: {mt5.last_error()}")

    levels = find_levels(m30, args.swing, args.swing)
    print(f"{args.symbol}  M30 levels from {len(m30)} bars -> {len(levels)} levels")
    print(f"execution on M3: {len(m3)} bars  "
          f"{dt.datetime.utcfromtimestamp(m3['time'][0]):%Y-%m-%d} -> "
          f"{dt.datetime.utcfromtimestamp(m3['time'][-1]):%Y-%m-%d}")
    print(f"stop {args.buffer:g} beyond level | spread ${spread:.2f} | "
          f"target = next level, min ${args.min_target:g} away\n")

    trades = simulate(m3, levels, args.buffer, args.min_target, spread, args.hold)
    ctrl = control(m3, trades, spread, args.hold)

    print(f"{'':<12}{'trades':>7}{'win%':>9}{'breakeven':>11}{'edge':>8}{'SE':>7}"
          f"{'avg R:R':>8}{'net $':>11}{'$/trade':>10}")
    print("-" * 84)
    report("SYSTEM", trades)
    report("control", ctrl)
    mt5.shutdown()


if __name__ == "__main__":
    main()
