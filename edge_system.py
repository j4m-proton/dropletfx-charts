"""The level break-and-retest system, encoded from the edge/ schematics.

The drawings show one pattern, in both directions:

    1. a horizontal level exists (a confirmed swing high or low)
    2. price CLOSES through it
    3. price then travels a real distance AWAY from the level  <-- the part my
       earlier attempt was missing, and the reason it fired on the break candle
    4. price comes back to the level from the other side
    5. a candle rejects it — closes back in the direction of the break
    6. enter there; stop just past the level

Support becomes resistance (sell) and resistance becomes support (buy).

Everything is scored against a control that takes the same number of trades at
random times with identical stop and target distances, because a 1:4 payoff
produces a low win rate whether or not any edge exists.
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

TF = {"M1": mt5.TIMEFRAME_M1, "M3": mt5.TIMEFRAME_M3, "M5": mt5.TIMEFRAME_M5,
      "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1}


def swing_levels(rates, strength):
    """Confirmed swing highs/lows, usable only from `strength` bars after they form."""
    h, l = rates["high"].astype(float), rates["low"].astype(float)
    out = []
    for i in range(strength, len(h) - strength):
        if h[i] == h[i - strength:i + strength + 1].max():
            out.append((i + strength, float(h[i])))
        if l[i] == l[i - strength:i + strength + 1].min():
            out.append((i + strength, float(l[i])))
    return out


def signals(rates, strength, min_excursion, max_wait, tol, cluster):
    """Emit (bar, side) for each break-away-retest-reject entry."""
    h = rates["high"].astype(float)
    l = rates["low"].astype(float)
    c = rates["close"].astype(float)
    n = len(c)

    # Raw pivots give thousands of levels a fraction of a point apart, so price
    # crosses dozens at once and the backtest opens absurd numbers of trades.
    # A trader marks distinct prices: fold levels within `cluster` together.
    ready = {}
    kept = []
    for bar, price in swing_levels(rates, strength):
        if any(abs(price - p) <= cluster for p in kept):
            continue
        kept.append(price)
        ready.setdefault(bar, []).append(price)

    live = np.empty(0)               # levels currently tradable
    # each watch: [level, side, state, extreme, bar_broken]
    #   side -1 = broke down (looking to sell the retest), +1 = broke up
    watches = []
    out = []

    for i in range(1, n):
        new = ready.get(i)
        if new:
            live = np.concatenate([live, np.asarray(new, dtype=float)])
        if live.size == 0:
            continue

        # 1-2. close through a level, vectorised — a python loop over every
        # level on every bar is quadratic and takes minutes on 50k bars.
        prev, cur = c[i - 1], c[i]
        for lvl in live[(cur < live) & (live <= prev)]:
            watches.append([float(lvl), -1, "away", cur, i])
        for lvl in live[(cur > live) & (live >= prev)]:
            watches.append([float(lvl), +1, "away", cur, i])

        still = []
        for w in watches:
            lvl, side, state, extreme, born = w
            if i - born > max_wait:
                continue
            if side < 0:
                extreme = min(extreme, l[i])
                # 3. has it travelled far enough away from the level?
                if state == "away" and (lvl - extreme) >= min_excursion:
                    state = "back"
                # 4-5. returned to the level and rejected it
                elif state == "back" and h[i] >= lvl - tol and c[i] < lvl:
                    out.append((i, -1, lvl))
                    continue
            else:
                extreme = max(extreme, h[i])
                if state == "away" and (extreme - lvl) >= min_excursion:
                    state = "back"
                elif state == "back" and l[i] <= lvl + tol and c[i] > lvl:
                    out.append((i, +1, lvl))
                    continue
            w[2], w[3] = state, extreme
            still.append(w)
        watches = still
    return out


def resolve(rates, entries, sl_d, tp_d, spread, horizon, sequential=True):
    """Resolve each entry.  With `sequential`, a new trade is only taken once
    the previous one has closed — one position at a time, as actually traded."""
    h, l, c = (rates["high"].astype(float), rates["low"].astype(float),
               rates["close"].astype(float))
    res = []
    free_from = 0
    for i, side, _lvl in entries:
        if i + horizon >= len(c):
            continue
        if sequential and i < free_from:
            continue
        entry = c[i] + side * spread
        tp = entry + side * tp_d
        sl = entry - side * sl_d
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
    picks = sorted((int(rng.integers(50, len(c) - horizon - 2)),
                    int(rng.choice([-1, 1])), 0.0) for _ in range(n * 3))
    return resolve(rates, picks, sl_d, tp_d, spread, horizon)


def line(name, res, sl, tp):
    n = len(res)
    if not n:
        print(f"  {name:<10} no trades")
        return None
    wr = 100 * res.mean()
    be = 100 * sl / (sl + tp)
    se = 100 * np.sqrt(wr / 100 * (1 - wr / 100) / n)
    net = res.sum() * tp - (~res).sum() * sl
    print(f"  {name:<10}{n:>7}{wr:>9.2f}%{be:>11.2f}%{wr - be:>+8.2f}{se:>7.2f}"
          f"{net:>11.0f}{net / n * 0.10:>+10.3f}")
    return wr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="Step Index")
    ap.add_argument("--tf", default="M1", choices=list(TF))
    ap.add_argument("--sl", type=float, default=10, help="pips")
    ap.add_argument("--tp", type=float, default=40, help="pips")
    ap.add_argument("--bars", type=int, default=50000)
    ap.add_argument("--pip", type=float, default=None)
    ap.add_argument("--horizon", type=int, default=1440)
    ap.add_argument("--cluster", type=float, default=10, help="merge levels within N pips")
    args = ap.parse_args()

    if not mt5.initialize(path=TERMINAL):
        raise SystemExit(mt5.last_error())
    mt5.symbol_select(args.symbol, True)
    info = mt5.symbol_info(args.symbol)
    tick = mt5.symbol_info_tick(args.symbol)
    pip = args.pip or (info.point * (10 if "XAU" in args.symbol.upper() else 1))
    spread = tick.ask - tick.bid
    rates = mt5.copy_rates_from_pos(args.symbol, TF[args.tf], 0, args.bars)

    print(f"{args.symbol} {args.tf}  {len(rates)} bars  "
          f"{dt.datetime.utcfromtimestamp(rates['time'][0]):%Y-%m-%d} -> "
          f"{dt.datetime.utcfromtimestamp(rates['time'][-1]):%Y-%m-%d}")
    print(f"SL {args.sl:g} / TP {args.tp:g} pips · 1 pip = {pip:g} · "
          f"spread {spread / pip:.1f} pips · breakeven "
          f"{100 * args.sl / (args.sl + args.tp):.2f}%\n")

    sl_d, tp_d = args.sl * pip, args.tp * pip
    print(f"  {'variant':<10}{'trades':>7}{'win%':>9}{'breakeven':>11}{'edge':>8}"
          f"{'SE':>7}{'net pips':>11}{'$/trade':>10}")
    print("  " + "-" * 70)

    ctrl = control(rates, 3000, sl_d, tp_d, spread, args.horizon)
    cw = line("CONTROL", ctrl, args.sl, args.tp)

    best = None
    for strength in (3, 5, 8):
        for exc in (10, 20, 40):
            ent = signals(rates, strength, exc * pip, max_wait=200,
                          tol=2 * pip, cluster=args.cluster * pip)
            res = resolve(rates, ent, sl_d, tp_d, spread, args.horizon)
            if len(res) < 100:
                continue
            wr = line(f"s{strength} exc{exc}", res, args.sl, args.tp)
            if wr is not None and (best is None or wr > best[0]):
                best = (wr, strength, exc, len(res))
    if best:
        wr, st, exc, n = best
        se = 100 * np.sqrt(wr / 100 * (1 - wr / 100) / n)
        print(f"\n  best: strength={st} excursion={exc}p -> {wr:.2f}%  "
              f"vs control {cw:.2f}%  = {(wr - cw) / se:+.1f} sigma")
    mt5.shutdown()


if __name__ == "__main__":
    main()
