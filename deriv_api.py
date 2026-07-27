"""Deriv WebSocket market-data client (asyncio).

Two delivery modes are supported and chosen automatically:

  * stream -- ``ticks_history`` with ``subscribe: 1``; the server pushes an
    ``ohlc`` message on every tick of the forming candle.
  * poll   -- plain ``ticks_history`` snapshots re-requested on a timer.

Streaming is attempted first.  Some regions / app_ids are not permitted to open
subscriptions -- the server answers ``InvalidSymbol`` to any ``subscribe``
request even though the identical snapshot request succeeds -- so the client
downgrades itself to polling on that error instead of dying.

Docs: https://developers.deriv.com/docs/data
"""

from __future__ import annotations

import asyncio
import json
import time

import websockets

ENDPOINT = "wss://ws.derivws.com/websockets/v3"
DEFAULT_APP_ID = "1089"  # Deriv's public demo app id

# Candle intervals the API accepts, in seconds.
GRANULARITIES = [60, 120, 180, 300, 600, 900, 1800,
                 3600, 7200, 14400, 28800, 86400]

# Shown in the symbol picker.  ``active_symbols`` is geo-gated on the public
# app id and often comes back empty, so we ship a known-good list and only
# replace it when the server actually returns one.
FALLBACK_SYMBOLS = [
    {"symbol": "R_10", "name": "Volatility 10 Index", "market": "Synthetics"},
    {"symbol": "R_25", "name": "Volatility 25 Index", "market": "Synthetics"},
    {"symbol": "R_50", "name": "Volatility 50 Index", "market": "Synthetics"},
    {"symbol": "R_75", "name": "Volatility 75 Index", "market": "Synthetics"},
    {"symbol": "R_100", "name": "Volatility 100 Index", "market": "Synthetics"},
    {"symbol": "1HZ10V", "name": "Volatility 10 (1s)", "market": "Synthetics"},
    {"symbol": "1HZ50V", "name": "Volatility 50 (1s)", "market": "Synthetics"},
    {"symbol": "1HZ100V", "name": "Volatility 100 (1s)", "market": "Synthetics"},
    {"symbol": "JD25", "name": "Jump 25 Index", "market": "Synthetics"},
    {"symbol": "JD100", "name": "Jump 100 Index", "market": "Synthetics"},
    {"symbol": "BOOM1000", "name": "Boom 1000 Index", "market": "Synthetics"},
    {"symbol": "CRASH1000", "name": "Crash 1000 Index", "market": "Synthetics"},
    {"symbol": "stpRNG", "name": "Step Index", "market": "Synthetics"},
    {"symbol": "frxEURUSD", "name": "EUR/USD", "market": "Forex"},
    {"symbol": "frxGBPUSD", "name": "GBP/USD", "market": "Forex"},
    {"symbol": "frxUSDJPY", "name": "USD/JPY", "market": "Forex"},
    {"symbol": "frxAUDUSD", "name": "AUD/USD", "market": "Forex"},
    {"symbol": "frxUSDCHF", "name": "USD/CHF", "market": "Forex"},
    {"symbol": "frxXAUUSD", "name": "Gold/USD", "market": "Commodities"},
    {"symbol": "frxXAGUSD", "name": "Silver/USD", "market": "Commodities"},
    {"symbol": "cryBTCUSD", "name": "BTC/USD", "market": "Crypto"},
    {"symbol": "cryETHUSD", "name": "ETH/USD", "market": "Crypto"},
]


class DerivClient:
    """One Deriv connection, driven by :meth:`watch`, emitting onto a queue.

    Events (dicts, discriminated by ``type``)::

        {"type": "status",  "text": ..., "mode": "stream"|"poll"}
        {"type": "error",   "text": ...}
        {"type": "symbols", "symbols": [...]}
        {"type": "candles", "symbol":…, "granularity":…, "candles": [...],
                            "pip_size":…, "initial": bool}
        {"type": "patch",   "symbol":…, "granularity":…, "candle": {...}}
    """

    # Deriv caps a single request at 5000 candles.
    MAX_COUNT = 5000

    # ``ticks_history`` sits on its own throttle bucket, separate from the
    # general per-minute budget, so a fixed 1s poll eventually trips it. Poll
    # mode therefore uses an adaptive interval: it runs at ``poll_floor`` when
    # all is well, doubles toward ``POLL_CEILING`` each time the server answers
    # RateLimit, then decays back toward the floor as clean polls come in.
    POLL_CEILING = 15.0

    def __init__(self, out: asyncio.Queue, app_id: str = DEFAULT_APP_ID,
                 count: int = MAX_COUNT, poll_interval: float = 1.0):
        self.out = out
        self.url = f"{ENDPOINT}?app_id={app_id}"
        self.count = min(count, self.MAX_COUNT)
        self._poll_floor = poll_interval
        self.poll_interval = poll_interval     # current effective interval

        self._symbol: str | None = None
        self._granularity = 60
        self._generation = 0          # bumped on every watch change
        self._req_id = 0
        self._pending: dict[int, tuple[str, int]] = {}   # req_id -> (kind, gen)
        self._streaming = True        # optimistic; cleared if the server refuses
        self._loaded = False          # got the first snapshot of this generation
        self._rewatch = False
        self._backfill_before: int | None = None
        self._wake = asyncio.Event()

    # ---------------------------------------------------------------- public

    def watch(self, symbol: str, granularity: int):
        """Point the client at a different symbol / timeframe."""
        if (symbol, granularity) == (self._symbol, self._granularity):
            return
        self._symbol, self._granularity = symbol, granularity
        self._generation += 1
        self._loaded = False
        self._pending.clear()
        self._backfill_before = None
        self._rewatch = True
        self._wake.set()

    def load_more(self, before: int):
        """Fetch the page of candles ending just before ``before`` (an epoch)."""
        self._backfill_before = int(before)
        self._wake.set()

    async def run(self):
        """Connect, and keep reconnecting, until cancelled."""
        backoff = 1.0
        while True:
            try:
                await self._session()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:                      # noqa: BLE001
                await self._emit(type="status",
                                 text=f"disconnected ({exc}) - reconnecting",
                                 mode=self.mode)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 20.0)

    @property
    def mode(self) -> str:
        return "stream" if self._streaming else "poll"

    # --------------------------------------------------------------- session

    async def _session(self):
        async with websockets.connect(self.url, ping_interval=20) as ws:
            await self._emit(type="status", text="connected", mode=self.mode)
            self._pending.clear()
            await self._send(ws, {"active_symbols": "brief"}, "symbols")
            if self._symbol:
                # A watch() that landed before the socket was up is served
                # here; clear the flags so the driver doesn't repeat it.
                self._rewatch = False
                self._wake.clear()
                await self._request_history(ws)

            reader = asyncio.create_task(self._reader(ws))
            driver = asyncio.create_task(self._driver(ws))
            done, pending = await asyncio.wait(
                {reader, driver}, return_when=asyncio.FIRST_EXCEPTION)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()          # re-raise so run() can reconnect

    async def _reader(self, ws):
        async for raw in ws:
            await self._handle(ws, json.loads(raw))

    async def _driver(self, ws):
        """Issues watch changes, history backfills and the poll-mode timer."""
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.poll_interval)
            except asyncio.TimeoutError:
                if not self._streaming and self._loaded:
                    await self._request_history(ws, kind="poll")
                continue
            self._wake.clear()

            if self._rewatch:
                self._rewatch = False
                if self._streaming:
                    await ws.send(json.dumps({"forget_all": "candles"}))
                await self._request_history(ws)

            if self._backfill_before is not None:
                before, self._backfill_before = self._backfill_before, None
                await self._request_history(ws, kind="backfill", end=before - 1)

    # --------------------------------------------------------------- outbound

    async def _send(self, ws, payload: dict, kind: str):
        self._req_id += 1
        payload["req_id"] = self._req_id
        self._pending[self._req_id] = (kind, self._generation)
        await ws.send(json.dumps(payload))

    async def _request_history(self, ws, kind: str = "history",
                               subscribe: bool | None = None,
                               end: int | None = None):
        if not self._symbol:
            return
        if subscribe is None:
            subscribe = self._streaming and kind == "history"
        req = {
            "ticks_history": self._symbol,
            "adjust_start_time": 1,
            # a poll only needs the tail of the series
            "count": 30 if kind == "poll" else self.count,
            "end": "latest" if end is None else str(end),
            "style": "candles",
            "granularity": self._granularity,
        }
        if subscribe:
            req["subscribe"] = 1
        await self._send(ws, req, kind)

    # ---------------------------------------------------------------- inbound

    async def _handle(self, ws, msg: dict):
        kind, gen = self._pending.pop(msg.get("req_id"), (None, None))
        stale = gen is not None and gen != self._generation

        if "error" in msg:
            await self._on_error(ws, msg, stale)
            return

        mtype = msg.get("msg_type")

        if mtype == "active_symbols":
            rows = msg.get("active_symbols") or []
            if rows:
                await self._emit(type="symbols", symbols=[
                    {"symbol": s["symbol"], "name": s["display_name"],
                     "market": s.get("market_display_name", "")}
                    for s in sorted(rows, key=lambda s: (s.get("market_display_name", ""),
                                                         s["display_name"]))
                ])
            return

        if mtype == "candles" and not stale:
            candles = [
                {"epoch": int(c["epoch"]), "open": float(c["open"]),
                 "high": float(c["high"]), "low": float(c["low"]),
                 "close": float(c["close"])}
                for c in msg.get("candles", [])
            ]
            if kind == "backfill":
                await self._emit(type="backfill", symbol=self._symbol,
                                 granularity=self._granularity, candles=candles)
                return
            initial = kind != "poll"
            if initial:
                self._loaded = True
            self._poll_recovered()          # a clean fetch: ease back toward 1s
            await self._emit(type="candles", symbol=self._symbol,
                             granularity=self._granularity, candles=candles,
                             pip_size=msg.get("pip_size", 2), initial=initial,
                             mode=self.mode)
            return

        if mtype == "ohlc":
            o = msg["ohlc"]
            if o.get("symbol") != self._symbol:
                return
            if int(o.get("granularity", 0)) != self._granularity:
                return
            await self._emit(type="patch", symbol=self._symbol,
                             granularity=self._granularity, candle={
                                 "epoch": int(o["open_time"]),
                                 "open": float(o["open"]), "high": float(o["high"]),
                                 "low": float(o["low"]), "close": float(o["close"]),
                             })

    async def _on_error(self, ws, msg: dict, stale: bool):
        err = msg["error"]
        code, text = err.get("code", ""), err.get("message", "error")
        asked_to_subscribe = bool(msg.get("echo_req", {}).get("subscribe"))

        # The tell-tale of a region that may read history but not subscribe.
        if asked_to_subscribe:
            if self._streaming:
                self._streaming = False
                await self._emit(
                    type="status", mode="poll",
                    text=f"live stream unavailable here - polling every {self.poll_interval:g}s")
            if not stale:
                await self._request_history(ws, subscribe=False)
            return
        # Deriv rate-limits ticks_history on its own bucket. It isn't a real
        # failure — the chart keeps its last candles — so don't surface it as an
        # error banner. Back the poll timer off and the next tick just retries.
        if code == "RateLimit":
            self.poll_interval = min(self.poll_interval * 2, self.POLL_CEILING)
            await self._emit(
                type="status", mode="poll",
                text=f"rate limited - easing updates to {self.poll_interval:g}s")
            return
        if stale:
            return
        await self._emit(type="error", text=f"{code}: {text}" if code else text)

    def _poll_recovered(self):
        """A clean fetch came back; decay the poll interval toward the floor."""
        if self.poll_interval > self._poll_floor:
            self.poll_interval = max(self._poll_floor, self.poll_interval * 0.8)

    # ------------------------------------------------------------------ util

    async def _emit(self, **event):
        event.setdefault("t", time.time())
        await self.out.put(event)
