"""MetaTrader 5 terminal bridge — account, quotes, positions and order entry.

The MetaTrader5 package is synchronous and is only safe to drive from one
thread, so every call is funnelled through a single-worker executor and awaited
from the event loop.

Safety notes, because this talks to a live trading terminal:

  * ``TRADE_ENABLED`` gates every state-changing call.  Flip it to False and the
    bridge becomes strictly read-only — quotes, positions and dry-run checks
    still work, order placement refuses.
  * The terminal's own "Algo Trading" switch is a second, independent gate that
    this code cannot and does not try to bypass.  If it is off, orders fail and
    the reason is surfaced verbatim.
  * ``check_order`` runs MT5's ``order_check``, which validates margin, volume
    and price *without* executing.  The UI runs it before every send.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading

import MetaTrader5 as mt5

TERMINAL_PATH = r"C:\Program Files\MetaTrader 5\terminal64.exe"

# Master switch for anything that can move money.  Read-only when False.
TRADE_ENABLED = True

MAGIC = 20260722          # tags orders this app placed
DEVIATION = 20            # max slippage, points

# Deriv WebSocket symbol -> MetaTrader 5 symbol.
SYMBOL_MAP = {
    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "R_100": "Volatility 100 Index",
    "1HZ10V": "Volatility 10 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index",
    "JD25": "Jump 25 Index",
    "JD100": "Jump 100 Index",
    "BOOM1000": "Boom 1000 Index",
    "CRASH1000": "Crash 1000 Index",
    "stpRNG": "Step Index",
    "frxEURUSD": "EURUSD",
    "frxGBPUSD": "GBPUSD",
    "frxUSDJPY": "USDJPY",
    "frxAUDUSD": "AUDUSD",
    "frxUSDCHF": "USDCHF",
    "frxXAUUSD": "XAUUSD",
    "frxXAGUSD": "XAGUSD",
    "cryBTCUSD": "BTCUSD",
    "cryETHUSD": "ETHUSD",
}

TRADE_MODES = {0: "DEMO", 1: "CONTEST", 2: "REAL"}

PENDING_TYPES = {
    mt5.ORDER_TYPE_BUY_LIMIT: "buy limit",
    mt5.ORDER_TYPE_SELL_LIMIT: "sell limit",
    mt5.ORDER_TYPE_BUY_STOP: "buy stop",
    mt5.ORDER_TYPE_SELL_STOP: "sell stop",
    mt5.ORDER_TYPE_BUY_STOP_LIMIT: "buy stop limit",
    mt5.ORDER_TYPE_SELL_STOP_LIMIT: "sell stop limit",
}


class Mt5Error(Exception):
    pass


class Mt5Bridge:
    """Async facade over the MetaTrader 5 terminal."""

    def __init__(self, path: str = TERMINAL_PATH):
        self.path = path
        self._pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="mt5")
        self._lock = threading.Lock()
        self._ready = False

    async def _call(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, fn, *args)

    # ------------------------------------------------------------- lifecycle

    def _connect_sync(self) -> dict:
        with self._lock:
            if not self._ready:
                if not mt5.initialize(path=self.path):
                    raise Mt5Error(f"initialize failed: {mt5.last_error()}")
                self._ready = True
        return self._account_sync()

    async def connect(self) -> dict:
        return await self._call(self._connect_sync)

    def _shutdown_sync(self):
        with self._lock:
            if self._ready:
                mt5.shutdown()
                self._ready = False

    async def shutdown(self):
        await self._call(self._shutdown_sync)
        self._pool.shutdown(wait=False)

    # --------------------------------------------------------------- account

    def _account_sync(self) -> dict:
        info = mt5.account_info()
        term = mt5.terminal_info()
        if info is None:
            raise Mt5Error(f"no account: {mt5.last_error()}")
        return {
            "login": info.login,
            "server": info.server,
            "name": info.name,
            "currency": info.currency,
            "balance": round(info.balance, 2),
            "equity": round(info.equity, 2),
            "margin": round(info.margin, 2),
            "margin_free": round(info.margin_free, 2),
            "profit": round(info.profit, 2),
            "leverage": info.leverage,
            "mode": TRADE_MODES.get(info.trade_mode, "?"),
            # Two independent gates; the UI shows both.
            "account_trade_allowed": bool(info.trade_allowed),
            "terminal_trade_allowed": bool(term.trade_allowed) if term else False,
            "app_trade_enabled": TRADE_ENABLED,
        }

    async def account(self) -> dict:
        return await self._call(self._account_sync)

    # ---------------------------------------------------------------- symbol

    @staticmethod
    def map_symbol(deriv_symbol: str) -> str | None:
        return SYMBOL_MAP.get(deriv_symbol)

    def _symbol_sync(self, deriv_symbol: str) -> dict | None:
        name = SYMBOL_MAP.get(deriv_symbol)
        if not name:
            return None
        info = mt5.symbol_info(name)
        if info is None:
            return None
        if not info.visible:                       # must be selected to quote
            mt5.symbol_select(name, True)
            info = mt5.symbol_info(name)
        tick = mt5.symbol_info_tick(name)
        # Dollars gained/lost per 1.0 of price movement, per 1.0 lot — the factor
        # the chart's order ticket multiplies by (price distance × this × volume)
        # to show live TP profit / SL loss without a round-trip per drag frame.
        tick_size = info.trade_tick_size or info.point
        money_per_price = (info.trade_tick_value / tick_size) if tick_size else None
        return {
            "deriv_symbol": deriv_symbol,
            "symbol": name,
            "digits": info.digits,
            "point": info.point,
            "spread": info.spread,
            "volume_min": info.volume_min,
            "volume_max": info.volume_max,
            "volume_step": info.volume_step,
            "tick_value": info.trade_tick_value,
            "tick_size": tick_size,
            "contract_size": info.trade_contract_size,
            "money_per_price": money_per_price,
            "trade_allowed": info.trade_mode != mt5.SYMBOL_TRADE_MODE_DISABLED,
            "bid": tick.bid if tick else None,
            "ask": tick.ask if tick else None,
        }

    async def symbol(self, deriv_symbol: str) -> dict | None:
        return await self._call(self._symbol_sync, deriv_symbol)

    @staticmethod
    def _filling(name: str) -> int:
        """Pick a filling mode the symbol actually supports."""
        info = mt5.symbol_info(name)
        mode = getattr(info, "filling_mode", 0) if info else 0
        if mode & 2:
            return mt5.ORDER_FILLING_IOC
        if mode & 1:
            return mt5.ORDER_FILLING_FOK
        return mt5.ORDER_FILLING_RETURN

    # ------------------------------------------------------------- positions

    def _positions_sync(self, deriv_symbol: str | None) -> list[dict]:
        name = SYMBOL_MAP.get(deriv_symbol) if deriv_symbol else None
        rows = mt5.positions_get(symbol=name) if name else mt5.positions_get()
        out = []
        for p in rows or []:
            out.append({
                "ticket": p.ticket,
                "symbol": p.symbol,
                "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
                "volume": p.volume,
                "price_open": p.price_open,
                "price_current": p.price_current,
                "sl": p.sl or None,
                "tp": p.tp or None,
                "profit": round(p.profit, 2),
                "time": p.time,
                "comment": p.comment,
            })
        return out

    async def positions(self, deriv_symbol: str | None = None) -> list[dict]:
        return await self._call(self._positions_sync, deriv_symbol)

    # -------------------------------------------------------- pending orders

    def _orders_sync(self, deriv_symbol: str | None) -> list[dict]:
        name = SYMBOL_MAP.get(deriv_symbol) if deriv_symbol else None
        rows = mt5.orders_get(symbol=name) if name else mt5.orders_get()
        out = []
        for o in rows or []:
            kind = PENDING_TYPES.get(o.type)
            if not kind:                       # market orders in flight
                continue
            out.append({
                "ticket": o.ticket,
                "symbol": o.symbol,
                "kind": kind,
                "side": "buy" if "buy" in kind else "sell",
                "volume": o.volume_current,
                "price_open": o.price_open,
                "sl": o.sl or None,
                "tp": o.tp or None,
                "time": o.time_setup,
                "comment": o.comment,
            })
        return out

    async def orders(self, deriv_symbol: str | None = None) -> list[dict]:
        return await self._call(self._orders_sync, deriv_symbol)

    def _modify_order_sync(self, ticket: int, price, sl, tp) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        rows = mt5.orders_get(ticket=ticket)
        if not rows:
            raise Mt5Error(f"pending order {ticket} not found")
        o = rows[0]
        res = mt5.order_send({
            "action": mt5.TRADE_ACTION_MODIFY,
            "order": o.ticket,
            "symbol": o.symbol,
            "price": float(price) if price else o.price_open,
            "sl": float(sl) if sl else 0.0,
            "tp": float(tp) if tp else 0.0,
            "type_time": mt5.ORDER_TIME_GTC,
        })
        if res is None:
            raise Mt5Error(f"modify failed: {mt5.last_error()}")
        return {"ok": res.retcode == mt5.TRADE_RETCODE_DONE,
                "retcode": res.retcode, "comment": res.comment}

    async def modify_order(self, ticket: int, price=None, sl=None, tp=None) -> dict:
        return await self._call(self._modify_order_sync, int(ticket), price, sl, tp)

    def _cancel_sync(self, ticket: int) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        res = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": int(ticket)})
        if res is None:
            raise Mt5Error(f"cancel failed: {mt5.last_error()}")
        return {"ok": res.retcode == mt5.TRADE_RETCODE_DONE,
                "retcode": res.retcode, "comment": res.comment}

    async def cancel_order(self, ticket: int) -> dict:
        return await self._call(self._cancel_sync, int(ticket))

    # ---------------------------------------------------------------- orders

    def _build_request(self, deriv_symbol, side, volume, sl, tp) -> dict:
        name = SYMBOL_MAP.get(deriv_symbol)
        if not name:
            raise Mt5Error(f"{deriv_symbol} has no MetaTrader 5 equivalent")
        info = mt5.symbol_info(name)
        if info is None:
            raise Mt5Error(f"unknown MT5 symbol {name}")
        if not info.visible:
            mt5.symbol_select(name, True)
        tick = mt5.symbol_info_tick(name)
        if tick is None:
            raise Mt5Error(f"no quote for {name}")

        volume = float(volume)
        if volume < info.volume_min or volume > info.volume_max:
            raise Mt5Error(
                f"volume must be between {info.volume_min} and {info.volume_max}")

        buy = side == "buy"
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": name,
            "volume": volume,
            "type": mt5.ORDER_TYPE_BUY if buy else mt5.ORDER_TYPE_SELL,
            "price": tick.ask if buy else tick.bid,
            "deviation": DEVIATION,
            "magic": MAGIC,
            "comment": "DropletFX",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._filling(name),
        }
        if sl:
            req["sl"] = float(sl)
        if tp:
            req["tp"] = float(tp)
        return req

    def _check_sync(self, deriv_symbol, side, volume, sl, tp) -> dict:
        req = self._build_request(deriv_symbol, side, volume, sl, tp)
        res = mt5.order_check(req)
        if res is None:
            raise Mt5Error(f"order_check failed: {mt5.last_error()}")
        return {
            "ok": res.retcode == 0,
            "retcode": res.retcode,
            "comment": res.comment,
            "balance": round(res.balance, 2),
            "equity": round(res.equity, 2),
            "margin": round(res.margin, 2),
            "margin_free": round(res.margin_free, 2),
            "price": req["price"],
            "symbol": req["symbol"],
            "volume": req["volume"],
        }

    async def check_order(self, deriv_symbol, side, volume, sl=None, tp=None) -> dict:
        """Validate an order without placing it (MT5 ``order_check``)."""
        return await self._call(self._check_sync, deriv_symbol, side, volume, sl, tp)

    def _send_sync(self, deriv_symbol, side, volume, sl, tp) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        req = self._build_request(deriv_symbol, side, volume, sl, tp)
        res = mt5.order_send(req)
        if res is None:
            raise Mt5Error(f"order_send failed: {mt5.last_error()}")
        return {
            "ok": res.retcode == mt5.TRADE_RETCODE_DONE,
            "retcode": res.retcode,
            "comment": res.comment,
            "order": res.order,
            "deal": res.deal,
            "price": res.price,
            "volume": res.volume,
        }

    async def send_order(self, deriv_symbol, side, volume, sl=None, tp=None) -> dict:
        return await self._call(self._send_sync, deriv_symbol, side, volume, sl, tp)

    def _pending_sync(self, deriv_symbol, side, volume, price, sl, tp) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        name = SYMBOL_MAP.get(deriv_symbol)
        if not name:
            raise Mt5Error(f"{deriv_symbol} has no MetaTrader 5 equivalent")
        info = mt5.symbol_info(name)
        if info is None:
            raise Mt5Error(f"unknown MT5 symbol {name}")
        if not info.visible:
            mt5.symbol_select(name, True)
        tick = mt5.symbol_info_tick(name)
        if tick is None:
            raise Mt5Error(f"no quote for {name}")

        volume = float(volume)
        if volume < info.volume_min or volume > info.volume_max:
            raise Mt5Error(
                f"volume must be between {info.volume_min} and {info.volume_max}")

        price = float(price)
        buy = side == "buy"
        # A buy resting below the market is a limit, above it is a stop (and the
        # mirror for a sell).  The ticket only ever sends limits, but the market
        # can move between the click and the send — resolve the type from where
        # the price actually sits so the terminal never rejects it outright.
        market = tick.ask if buy else tick.bid
        if buy:
            otype = mt5.ORDER_TYPE_BUY_LIMIT if price < market else mt5.ORDER_TYPE_BUY_STOP
        else:
            otype = mt5.ORDER_TYPE_SELL_LIMIT if price > market else mt5.ORDER_TYPE_SELL_STOP

        req = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": name,
            "volume": volume,
            "type": otype,
            "price": price,
            "deviation": DEVIATION,
            "magic": MAGIC,
            "comment": "DropletFX pending",
            "type_time": mt5.ORDER_TIME_GTC,
            # Pending orders fill on trigger; RETURN is the mode brokers accept
            # for them regardless of the symbol's market-order filling flags.
            "type_filling": mt5.ORDER_FILLING_RETURN,
        }
        if sl:
            req["sl"] = float(sl)
        if tp:
            req["tp"] = float(tp)
        res = mt5.order_send(req)
        if res is None:
            raise Mt5Error(f"pending order failed: {mt5.last_error()}")
        return {
            "ok": res.retcode == mt5.TRADE_RETCODE_DONE,
            "retcode": res.retcode,
            "comment": res.comment,
            "order": res.order,
            "kind": PENDING_TYPES.get(otype, "pending"),
            "price": price,
        }

    async def place_pending(self, deriv_symbol, side, volume, price,
                            sl=None, tp=None) -> dict:
        """Place a resting limit/stop order at ``price`` with optional SL/TP."""
        return await self._call(self._pending_sync, deriv_symbol, side,
                                volume, price, sl, tp)

    def _close_sync(self, ticket: int) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        rows = mt5.positions_get(ticket=ticket)
        if not rows:
            raise Mt5Error(f"position {ticket} not found")
        p = rows[0]
        tick = mt5.symbol_info_tick(p.symbol)
        buy = p.type == mt5.POSITION_TYPE_BUY
        res = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": p.volume,
            "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
            "position": p.ticket,
            "price": tick.bid if buy else tick.ask,
            "deviation": DEVIATION,
            "magic": MAGIC,
            "comment": "DropletFX close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._filling(p.symbol),
        })
        if res is None:
            raise Mt5Error(f"close failed: {mt5.last_error()}")
        return {"ok": res.retcode == mt5.TRADE_RETCODE_DONE,
                "retcode": res.retcode, "comment": res.comment}

    async def close_position(self, ticket: int) -> dict:
        return await self._call(self._close_sync, int(ticket))

    def _modify_sync(self, ticket: int, sl, tp) -> dict:
        if not TRADE_ENABLED:
            raise Mt5Error("order placement is disabled in mt5_bridge.TRADE_ENABLED")
        rows = mt5.positions_get(ticket=ticket)
        if not rows:
            raise Mt5Error(f"position {ticket} not found")
        p = rows[0]
        res = mt5.order_send({
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": p.symbol,
            "position": p.ticket,
            "sl": float(sl) if sl else 0.0,
            "tp": float(tp) if tp else 0.0,
        })
        if res is None:
            raise Mt5Error(f"modify failed: {mt5.last_error()}")
        return {"ok": res.retcode == mt5.TRADE_RETCODE_DONE,
                "retcode": res.retcode, "comment": res.comment}

    async def modify_position(self, ticket: int, sl=None, tp=None) -> dict:
        return await self._call(self._modify_sync, int(ticket), sl, tp)
