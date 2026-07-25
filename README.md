# DropletFX Charts

A TradingView-style candlestick chart on live Deriv market data, in DropletFX
livery. Python does the market-data work; the chart itself is a canvas renderer
styled with Tailwind CSS.

Run it either as a desktop app or in a browser:

```
cd desktop && npm start     # DropletFX Charts desktop window
python server.py            # or plain browser -> http://127.0.0.1:8000
```

No build step and no install if you already have `starlette`, `uvicorn` and
`websockets`; otherwise `pip install -r requirements.txt`.

## What's in it

| | |
|---|---|
| **Candlesticks** | live OHLC from Deriv, 5000 bars up front, more loaded as you pan left |
| **Timeframes** | 1m 2m 3m 5m 10m 15m 30m 1h 2h 4h 8h 1D |
| **Trend line** | draw, select, drag either end, drag the whole line, delete |
| **Magnet** | snaps a trend-line endpoint to the nearest O/H/L/C |
| **Pips counter** | live pip distance from the crosshair to the last close, plus each candle's range in pips |
| **Zoom** | wheel, the ± buttons, `+` / `-`, or drag either axis |
| **Timezone** | Africa/Nairobi (EAT) throughout, independent of the machine clock |
| **Save** | exports the chart exactly as shown to a PNG |
| **Themes** | dark and light, each with its own palette |

### Keys

`T` trend line · `Esc` cursor / cancel · `M` magnet · `Del` delete selected ·
`+` / `-` zoom · double-click resets the view

## Desktop app

`desktop/` is an Electron shell following the same shape as `drip/cashier-desktop`
— `electron/main.cjs`, a preload bridge, a branded splash, and electron-builder
producing an NSIS installer.

```
cd desktop
npm install
npm start           # run       (npm run dev for devtools)
npm run build       # -> release/  installer + zip
```

Produces `release/DropletFX Charts Setup 1.0.0.exe` (79 MB, NSIS, per-user, lets
the user choose the install directory) and a 107 MB portable zip.

**A first build on Windows usually fails** while unpacking electron-builder's
`winCodeSign` package: it contains macOS symlinks (`libcrypto.dylib`,
`libssl.dylib`) and creating symlinks needs elevation or Developer Mode. The
fix is to pre-extract it without the macOS parts:

```sh
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
node_modules/7zip-bin/win/x64/7za.exe x "$CACHE"/<hash>.7z \
    -o"$CACHE/winCodeSign-2.6.0" '-xr!darwin' -y
```

Builds are unsigned, so Windows SmartScreen will warn on first run until the
executable is signed with a real certificate.

The difference from a Vite app is that the UI here is served by Python, so the
main process owns the **server's whole lifecycle**: it finds an interpreter,
picks a free port, spawns `server.py`, waits until the port genuinely accepts a
connection, and only then points the window at it. A startup failure is written
onto the splash rather than leaving a blank window.

The Python child must never outlive the shell. Graceful quit kills it, but a
force-kill of Electron would not — so `server.py` also runs a watchdog on stdin
(armed only by `DFX_MANAGED=1`) and exits the moment that pipe closes.

`server.py` still runs standalone; `DFX_PORT` / `DFX_HOST` override the
defaults, and the watchdog stays disarmed.

Requires Python 3 on PATH (or `DFX_PYTHON` pointing at one) with the
`requirements.txt` packages installed — the shell does not bundle an
interpreter.

## Branding

Assets live in `brand/` and are served at `/brand`. The toolbar carries the
DropletFX lockup and the tab uses the DFX badge as its favicon.

The source SVGs are 1024×1024 with the wordmark centred, so the toolbar crops
to the measured content box rather than scaling the whole square — content is
`943×226` at offset `(40, 399)`, which the wrapper in `index.html` reproduces.
Two variants swap on theme: `DropletFX-logo-transparent.svg` (white wordmark)
in dark, `-darktext.svg` in light.

The palette combines the logo's own colours with the owner's Deriv chart
configuration (`charts.deriv.com` → `localStorage['tradingview.chartproperties']`):

| Token | Value | Source |
|---|---|---|
| Chart pane | `#000000` | requested — pure black |
| Chrome / toolbar | `#0b0b0f` | the logo SVGs' own dark surface |
| Brand accent + drawings | `#f50512` | DropletFX badge gradient (top stop; `#c2000e` is the bottom) |
| Scale text | `#b8b8b8` | `scalesProperties.textColor` |
| Crosshair | `#9c9c9c` | `crossHairProperties.color` |
| Axis label chip | `#2e2e2e` | `linetoolpricerange.labelBackgroundColor` |
| Light-mode ink | `#15212d` | Deriv `--text-color` |
| Up / down candles | `#00e676` / `#2979ff` | requested — green / blue |

The candle pair was chosen with `scripts/validate_palette.js` from the dataviz
skill rather than by eye. On black, `#00e676`/`#2979ff` separate by ΔE 37.5
under deuteranopia and 20.4 under tritanopia; the first green/blue pair tried
(`#0ecb81`/`#3b9dff`) scored only 6.8 on tritan, which is inside the "unusable
without a secondary encoding" band. Light mode re-picks darker steps
(`#00a854`/`#1e63d0`) because the vivid green reads at just 1.67:1 on white —
it is a re-pick, not an inverted flip. The **Hollow** toggle adds a shape
encoding on top of the hues.

Two settings in that config were deliberately **not** adopted, because they
contradict explicit instructions for this chart: it had gridlines enabled
(`rgba(242,242,242,0.06)`) and a `Etc/UTC` timezone, whereas this chart has the
grid removed and runs on Africa/Nairobi.

Colours live in exactly two places — `THEMES` in `static/chart.js` for the
canvas, and the Tailwind `theme.extend.colors` block in `static/index.html` for
the chrome. Trend lines read their colour from the active theme rather than
storing one, so re-branding repaints existing drawings too.

## Layout

| File | Role |
|---|---|
| `brand/` | DropletFX logo and icon assets, served at `/brand` |
| `deriv_api.py` | Deriv WebSocket client — history, live updates, reconnect |
| `mt5_bridge.py` | MetaTrader 5 terminal — account, quotes, positions, orders |
| `static/trade.js` | Order panel — validation, two-step confirm, positions |
| `server.py` | Starlette app; serves the UI and bridges each browser to its own Deriv connection |
| `static/index.html` | Tailwind chrome — toolbar, legend, status bar |
| `static/chart.js` | Canvas renderer, interaction, drawing tools |

## Trading through MetaTrader 5

The right-hand panel places real orders through a running MetaTrader 5 terminal
(`mt5_bridge.py`). Charting stays on Deriv's WebSocket; MT5 is used only for
account state, quotes, positions and order entry, so the chart still works with
the terminal closed.

### Before it will trade

1. MetaTrader 5 must be **installed and logged in** — the bridge attaches to
   whichever account the terminal already has open.
2. **Algo Trading must be enabled** in the terminal (its toolbar button, or
   Tools → Options → Expert Advisors). The Python API cannot place orders
   without it, and this code does not attempt to work around that.

Both gates are reported separately in the panel, because they have different
fixes, and the order buttons stay disabled until every gate is clear.

### Safety design

Order entry is **two-step**. The first click runs MT5's `order_check`, which
validates volume, margin and price *without executing*, and shows what the
order would cost; only a second click on the now-red CONFIRM button sends it.
The arming lapses after 6 seconds, and editing volume/SL/TP disarms it, so a
stale confirmation cannot fire into a market that has moved.

`mt5_bridge.TRADE_ENABLED = False` makes the whole bridge read-only —
quotes, positions and dry-run checks keep working, order placement refuses.
Use it if you want the panel for monitoring only.

Orders this app places are tagged `magic = 20260722`, comment `DropletFX`.

### Levels on the chart

Open positions and **pending orders** both draw on the chart: entry, SL and TP.
Position entries are tinted by P&L, pending-order entries are amber, SL is red
and TP is green throughout.

**SL and TP drag like they do in MetaTrader.** Grab the line and move it; a
pending order's entry price drags too. While dragging, a bubble shows the new
price and its distance from entry in pips, and magnet mode snaps to nearby OHLC
levels. On release the change is sent as `TRADE_ACTION_SLTP` (positions) or
`TRADE_ACTION_MODIFY` (pending orders).

Because the terminal is only polled every 2s, a dragged level is held
optimistically until the poll catches up, so it does not snap back and then
jump. If the terminal *rejects* the change, the optimistic value is dropped
immediately and the line returns to what MT5 actually holds — a rejected drag
never leaves a lie on screen. Polls are also ignored mid-drag so the level under
the cursor can't fight the incoming data.

A position with no SL/TP has no line to grab, so each position card carries
compact SL/TP fields; set one there and it becomes draggable.

### Reading P&L

Profit and loss use **reserved status colours** — green for profit, **red for
loss** — which are deliberately *not* the candle colours. A down candle is blue
here, but a losing trade must still read as red, so `profit`/`loss` are separate
tokens from `up`/`down` in both the Tailwind config and `THEMES`.

A **floating orb** over the chart shows total P&L across all running trades,
ringed green or red, with the trade count beneath. It is hidden entirely when
nothing is open, and can be dragged anywhere over the chart.

### Symbols

`SYMBOL_MAP` in `mt5_bridge.py` maps Deriv WebSocket symbols to MT5 symbols
(`R_100` → `Volatility 100 Index`, `frxEURUSD` → `EURUSD`, `cryBTCUSD` →
`BTCUSD`, …). All 22 charted symbols resolve. A symbol with no mapping charts
normally and the panel says it is not tradable, rather than guessing.

Volume limits, step and price digits are read from the live symbol rather than
assumed — they vary a lot on Deriv's synthetics (Step Index min 0.1, Volatility
75 min 0.01, Volatility 50 min 4.0).

## How much history you get

**Deriv serves a rolling one year, and no more.** That is a server-side cap, not
a request-size limit: asking for 10000 candles, or passing `start` two years
back, or paging with `end` set before the boundary all return the same one-year
window. Verified against R_100, 1HZ100V, EUR/USD, Gold and BTC/USD — every one
stops at 366 daily candles.

So two years is not obtainable from this API. What the chart does instead is
load everything that *is* available: 5000 candles per request (the per-request
maximum), then automatically fetching the next older page whenever you pan near
the oldest bar, until the server runs out — at which point the status bar says
so. On 1D that reaches the full year immediately; on 1m it deepens by ~3.5 days
per page as you scroll back.

Because 1D therefore tops out at ~366 candles, the view opens fully zoomed out
whenever the whole series is under `FIT_ALL_BELOW` (400) bars, instead of
showing a 120-bar slice of it. Symbols that don't trade at weekends have fewer
still — EUR/USD and Gold return ~260 daily candles for the same year.

If you need genuine multi-year history, it has to come from a different source
(a broker with deeper archives, or your own recorded candles); the chart would
only need `applyCandles` fed from that source instead.

## How the data arrives

`deriv_api.py` asks for `ticks_history` with `style: "candles"` and the chosen
`granularity`, and tries to open a live subscription (`subscribe: 1`), which
pushes an `ohlc` message on every tick of the forming candle.

**Some regions cannot open subscriptions on the public app id.** The server
answers `InvalidSymbol` to any `subscribe` request even though the identical
snapshot request succeeds — which is the case from this machine. The client
detects that specific rejection, downgrades itself to re-requesting snapshots
every 2s, and says so in the status bar (`polling` instead of `live stream`).
Nothing needs configuring; the chart updates either way.

To use your own Deriv application instead of the public demo id, pass it
through:

```python
DerivClient(events, app_id="YOUR_APP_ID")   # server.py, in feed()
```

`active_symbols` is geo-gated the same way and often returns an empty list, so
the symbol picker falls back to the built-in list in `deriv_api.py` and is
replaced automatically whenever the server does return one.

## Drawings and settings

Trend lines are stored per symbol as `(epoch, price)` pairs, not as pixels — so
they hold their anchor through pan, zoom and timeframe changes, exactly like
TradingView. They live in `localStorage` under `deriv-chart:drawings:<symbol>`,
alongside `deriv-chart:settings` (symbol, timeframe, theme, magnet, hollow).

Note that `localStorage` is scoped to the *origin*, so anything else you have
served from `http://127.0.0.1:8000` shares that namespace.

## What talks to what

The Deriv side is read-only: it calls `ticks_history` / `active_symbols` only,
with no authentication and no account access. Everything that can move money
goes through the MetaTrader 5 terminal instead, behind the gates described
above.
