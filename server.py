"""Local web server for the Deriv candlestick chart.

Serves the Tailwind UI and bridges the browser to Deriv over a WebSocket:
each browser connection gets its own :class:`DerivClient`.

Run:  python server.py   ->  http://127.0.0.1:8000
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import pathlib
import sys
import threading

import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from deriv_api import (DEFAULT_APP_ID, FALLBACK_SYMBOLS, GRANULARITIES,
                       DerivClient)
from mt5_bridge import Mt5Bridge, Mt5Error

# One terminal, so one bridge shared by every browser connection.
bridge = Mt5Bridge()

# Frozen (PyInstaller onefile) unpacks the code to a temp dir, so __file__ is
# useless for finding our assets — they ship next to the .exe instead. In dev
# they sit next to this script.
if getattr(sys, "frozen", False):
    ROOT = pathlib.Path(sys.executable).parent
else:
    ROOT = pathlib.Path(__file__).parent
STATIC = ROOT / "static"
BRAND = ROOT / "brand"

# Drawings persist to a plain JSON file, not the browser's localStorage — that
# way they survive whatever the renderer's origin/port happens to be, a cleared
# cache, or a reinstall.  The desktop shell points DFX_DATA at a writable
# per-user folder; a bare `python server.py` just uses ./data next to the code.
DATA_DIR = pathlib.Path(os.environ.get("DFX_DATA") or (ROOT / "data"))
DRAWINGS_FILE = DATA_DIR / "drawings.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
_drawings_lock = threading.Lock()
_settings_lock = threading.Lock()


def _read_drawings() -> dict:
    try:
        with open(DRAWINGS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    # Migrate the old flat {symbol: [...]} shape into {"main": {symbol: [...]}}.
    if data and any(isinstance(v, list) for v in data.values()):
        return {"main": data}
    return data


def _write_json(path: pathlib.Path, store: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(store, fh)
    os.replace(tmp, path)                   # atomic: never a half-written file


def _write_drawings(store: dict) -> None:
    _write_json(DRAWINGS_FILE, store)


def _read_settings() -> dict:
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


async def index(_request):
    return FileResponse(STATIC / "index.html")


async def config(_request):
    return JSONResponse({
        "app_id": DEFAULT_APP_ID,
        "granularities": GRANULARITIES,
        "symbols": FALLBACK_SYMBOLS,
    })


async def get_settings(request):
    """Return one workspace's saved settings (timeframe, symbol, theme, ...).

    These used to live in the browser's localStorage, which did not survive a
    restart reliably; keeping them next to the drawings makes them durable.
    """
    ws = request.query_params.get("workspace", "main")
    with _settings_lock:
        store = _read_settings()
    bucket = store.get(ws)
    return JSONResponse(bucket if isinstance(bucket, dict) else {})


async def put_settings(request):
    """Persist one workspace's settings: body {workspace, settings:{...}}."""
    try:
        body = await request.json()
        ws = str(body.get("workspace", "main"))
        settings = body.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("settings must be an object")
    except (KeyError, ValueError, TypeError):
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    with _settings_lock:
        store = _read_settings()
        store[ws] = settings
        _write_json(SETTINGS_FILE, store)
    return JSONResponse({"ok": True})


async def get_drawings(request):
    """Return one workspace's {symbol: [drawings]} map.

    Data is stored as {workspace: {symbol: [...]}} so multiple windows keep
    their drawings apart.  ?workspace=<id> selects one; default is "main".
    """
    ws = request.query_params.get("workspace", "main")
    with _drawings_lock:
        store = _read_drawings()
    bucket = store.get(ws)
    return JSONResponse(bucket if isinstance(bucket, dict) else {})


async def put_drawings(request):
    """Persist one symbol's drawings for a workspace:
    body {workspace, symbol, drawings:[...]}."""
    try:
        body = await request.json()
        ws = str(body.get("workspace", "main"))
        symbol = str(body["symbol"])
        drawings = body.get("drawings") or []
    except (KeyError, ValueError, TypeError):
        return JSONResponse({"ok": False, "error": "bad body"}, status_code=400)
    with _drawings_lock:
        store = _read_drawings()
        bucket = store.get(ws)
        if not isinstance(bucket, dict):
            bucket = {}
        if drawings:
            bucket[symbol] = drawings
        else:
            bucket.pop(symbol, None)        # empty list = cleared; drop the key
        if bucket:
            store[ws] = bucket
        else:
            store.pop(ws, None)
        _write_drawings(store)
    return JSONResponse({"ok": True})


async def feed(websocket: WebSocket):
    """Relay between one browser, one Deriv connection and the MT5 terminal."""
    await websocket.accept()
    events: asyncio.Queue = asyncio.Queue()
    client = DerivClient(events)
    state = {"symbol": None}

    async def pump():
        """Events -> browser."""
        while True:
            await websocket.send_json(await events.get())

    async def mt5_poll():
        """Push account, quote and open positions on a timer."""
        connected = False
        while True:
            try:
                if not connected:
                    await bridge.connect()
                    connected = True
                payload = {
                    "type": "mt5",
                    "account": await bridge.account(),
                    "positions": await bridge.positions(),
                    "orders": await bridge.orders(),
                    "symbol": await bridge.symbol(state["symbol"])
                              if state["symbol"] else None,
                }
                await events.put(payload)
            except Exception as exc:                    # noqa: BLE001
                connected = False
                await events.put({"type": "mt5_error", "text": str(exc)})
            await asyncio.sleep(2)

    async def trade_action(msg: dict):
        """Order entry.  Every path reports back, success or failure."""
        action = msg["action"]
        try:
            if action == "mt5_check":
                res = await bridge.check_order(
                    msg["symbol"], msg["side"], msg["volume"],
                    msg.get("sl"), msg.get("tp"))
                await events.put({"type": "mt5_check", "result": res})
            elif action == "mt5_order":
                res = await bridge.send_order(
                    msg["symbol"], msg["side"], msg["volume"],
                    msg.get("sl"), msg.get("tp"))
                await events.put({"type": "mt5_order", "result": res})
            elif action == "mt5_pending":
                res = await bridge.place_pending(
                    msg["symbol"], msg["side"], msg["volume"], msg["price"],
                    msg.get("sl"), msg.get("tp"))
                await events.put({"type": "mt5_pending", "result": res})
            elif action == "mt5_close":
                res = await bridge.close_position(msg["ticket"])
                await events.put({"type": "mt5_order", "result": res})
            elif action == "mt5_modify":
                res = await bridge.modify_position(
                    msg["ticket"], msg.get("sl"), msg.get("tp"))
                await events.put({"type": "mt5_order", "result": res})
            elif action == "mt5_modify_order":
                res = await bridge.modify_order(
                    msg["ticket"], msg.get("price"), msg.get("sl"), msg.get("tp"))
                await events.put({"type": "mt5_order", "result": res})
            elif action == "mt5_cancel":
                res = await bridge.cancel_order(msg["ticket"])
                await events.put({"type": "mt5_order", "result": res})
        except (Mt5Error, KeyError, ValueError, TypeError) as exc:
            await events.put({"type": "mt5_result_error", "text": str(exc)})

    runner = asyncio.create_task(client.run())
    pumper = asyncio.create_task(pump())
    poller = asyncio.create_task(mt5_poll())
    try:
        while True:                                   # browser -> services
            msg = await websocket.receive_json()
            action = msg.get("action")
            if action == "watch":
                granularity = int(msg.get("granularity", 60))
                if granularity not in GRANULARITIES:
                    granularity = 60
                state["symbol"] = str(msg["symbol"])
                client.watch(str(msg["symbol"]), granularity)
            elif action == "more":
                client.load_more(int(msg["before"]))
            elif action and action.startswith("mt5_"):
                # Fire and forget so a slow terminal call can't stall the socket.
                asyncio.create_task(trade_action(msg))
    except (WebSocketDisconnect, RuntimeError, KeyError, ValueError):
        pass
    finally:
        for task in (runner, pumper, poller):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


class NoStoreMiddleware:
    """Serve every asset fresh — never let the desktop shell cache the page.

    Electron/Chromium persists an HTTP cache in the app's user-data dir. Static
    files here carry an ETag / Last-Modified but no Cache-Control, so Chromium is
    free to reuse a stale copy (heuristic freshness) and would keep showing an old
    index.html across restarts even after the file on disk changed. For a local
    single-user server the whole cache is pure downside, so we:
      - strip the browser's conditional-request headers, forcing a full 200 every
        time (a previously-cached ETag can't win a 304), and
      - drop the validators on the way out and stamp `no-store`, so nothing new
        gets cached either.
    """
    _DROP_REQ = (b"if-none-match", b"if-modified-since")
    _DROP_RESP = (b"cache-control", b"etag", b"last-modified", b"expires")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        scope = dict(scope)
        scope["headers"] = [(k, v) for (k, v) in scope["headers"]
                            if k.lower() not in self._DROP_REQ]

        async def send_no_store(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for (k, v) in message.get("headers", [])
                           if k.lower() not in self._DROP_RESP]
                headers.append((b"cache-control", b"no-store, max-age=0"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_no_store)


app = Starlette(routes=[
    Route("/", index),
    Route("/api/config", config),
    Route("/api/drawings", get_drawings, methods=["GET"]),
    Route("/api/drawings", put_drawings, methods=["POST"]),
    Route("/api/settings", get_settings, methods=["GET"]),
    Route("/api/settings", put_settings, methods=["POST"]),
    WebSocketRoute("/ws", feed),
    ], middleware=[Middleware(NoStoreMiddleware)], on_startup=[])
app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/brand", StaticFiles(directory=BRAND), name="brand")


def _die_with_parent():
    """Exit when the desktop shell that spawned us goes away.

    Electron's graceful quit kills this process, but a force-kill of the shell
    would not — and an orphaned server would keep a MetaTrader connection and a
    port alive with no window attached.  Watching stdin for EOF is the portable
    way to notice: the pipe closes the moment the parent dies.
    """
    def watch():
        try:
            sys.stdin.read()
        except Exception:                                # noqa: BLE001
            pass
        os._exit(0)

    threading.Thread(target=watch, daemon=True, name="parent-watchdog").start()


if __name__ == "__main__":
    # The desktop shell picks a free port and passes it in, so a second
    # instance never collides with an already-running one.
    host = os.environ.get("DFX_HOST", "127.0.0.1")
    port = int(os.environ.get("DFX_PORT", "8000"))
    # Only when launched by the desktop shell — a terminal keeps stdin open,
    # so this must not arm itself for a plain `python server.py`.
    if os.environ.get("DFX_MANAGED") == "1":
        _die_with_parent()
    # Flushed, because the Electron main process watches stdout for this line.
    print(f"DropletFX charts -> http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
