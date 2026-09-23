# Farmranger Tag Bot

A **lightweight Telegram front end for [tagexplore-web](../tagexplore-web)**. It runs
**one or more Telegram bots from a single process**, each connected to one
organisation in the web app. Every bot reads that organisation's tag-discovery data
from the web app's API and reports it in Telegram — raw discovery tables, daily
summaries, battery charts, GPS lookups and satellite maps. It pushes new discoveries
to subscribers as they appear.

The bot does **no log scraping, parsing or merging of its own** — the tagexplore-web
app does all of that and stores the results. The bot only ever reads back through a
per-organisation access token, so it stays small and cheap to run.

Each bot has a **level** — `dev` (full technical insight) or `client` (a reduced,
non-technical view) — which is set on its access token in the web app. Bots are added
and managed live through an owner-only **manager bot**; no redeploy needed.

## How it fits together

```
Farmranger logs ──▶ tagexplore-web (scrape, parse, store in SQLite) ──▶ web API
                                                                          │
                                        Authorization: Bearer <token>     │
                                                                          ▼
                                                          Farmranger Tag Bot (this)
                                                            reads one org, shows in Telegram
```

- **tagexplore-web** owns everything: devices/IMEIs, the tag whitelist, ingest
  scheduling, and the database. It manages all of that in its own admin UI.
- **This bot** only *connects* a Telegram bot to an existing organisation and chooses
  its dev/client level. It never allocates IMEIs or edits whitelists.

The only coupling is two HTTP surfaces the web app exposes:

- `GET /api/bot/context` and `GET /api/bot/readings` — the per-org read API, authed by
  a bot access token (one per bot).
- `GET /api/provision/orgs`, `POST|PATCH|DELETE /api/provision/tokens` — a
  server-to-server API the manager bot uses to mint/level/revoke those tokens, authed
  by a single shared `BOT_PROVISION_TOKEN`.

## Local setup

```
npm install
cp .env.example .env   # fill in real values (a working .env is already present locally)
npm start
```

Set at least `WEB_API_BASE` (where tagexplore-web is reachable). To add bots through
the manager, also set `WEB_PROVISION_TOKEN` (matching the web app's), plus
`MANAGER_BOT_TOKEN` / `MANAGER_CHAT_ID`.

Then in Telegram, message a worker bot `/start` to see its menu.

History never reaches earlier than `HISTORY_START` (device data isn't valid before then).

## Features

- **Live push**: every new discovery round is sent to everyone who tapped "Opt In" for
  that bot, as soon as it's detected on the next poll. No chat is pre-subscribed —
  every bot starts with zero subscribers, including you; message the bot `/start` and
  tap Opt In to receive its live updates.
- **`/start` menu** (button labels kept short for mobile — full names below):
  - 📋 Latest / 4h / 24h — raw per-round tag tables. Raw views also append any
    **missing tags** (seen in the last `LIVE_WINDOW_HOURS` but not in the last
    `MISSING_THRESHOLD_HOURS`).
  - 📊 1d / 3d / 7d — daily summaries: **total discoveries that day**, **combined
    unique tag count per discovery** (deduped across all of the org's devices)
    alongside each device's own count, plus the day's full unique-tag roll-up.
  - 🔍 Missing — same missing-tags list on demand.
  - 📍 GPS — prompts for a tag ID, returns its last known GPS fix as a Google Maps link.
  - 🛰 Map — satellite map with a coloured pin per tag at its last known GPS fix. Pin
    colour = age of fix: 🟢 <2h, 🟡 <24h, 🟠 <3d, 🔴 older. Tags that have never
    reported GPS are listed in the caption.
  - 🔥 Heat — spatial density heatmap of all GPS readings, on satellite (last 3 days).
  - 🔋 Battery — full-fleet snapshot chart (latest reading per tag).
  - 📉 Trend — prompts for one or more tag IDs, returns a 7-day battery-over-time line
    chart for just those tags (one line per tag).
  - 🕒 Count — unique tag count over a rolling window you specify.
  - ✅/❌ Opt in/out of live push updates.
- **Text commands** (dev): `/battery ID [ID ...]` or `/battery *` (7-day trend),
  `/gps ID`, `/missing`, `/count Nh`, `/heatmap`, `/map`. On client bots `/battery`,
  `/heatmap` and `/map` are disabled.

## Bots, levels & the manager bot

Every bot is a registry entry: `{ id, name, token, level, adminChatId, apiToken }`,
stored in `data/registry.json` on the volume. `token` is the Telegram bot token;
`apiToken` is the web app's org access token that decides which organisation the bot
reads and — authoritatively — its level. All bots run in one process and share the same
poll tick (default every 60s); each keeps its own state and subscriber list under
`data/<id>/`.

**Levels** change only what a bot shows:
- `dev` — full raw tables (RSSI/hops/waves/mov/FW + discovery duration + per-device/IMEI
  breakdown), daily summaries with per-device columns and the day's tag-ID list, plus
  the Trend chart, 🛰 Map and 🔥 Heat.
- `client` — raw discovery and live push show **only Tag ID, a battery status dot
  (🟢/🟡/🔴) and GPS Y/N**, with the combined unique count as the headline. Summaries
  show **Time + Combined only**. Trend, 🛰 Map and 🔥 Heat are removed.

The level (and the org's tag whitelist, including which tags are switched off) are
re-read from the web app periodically (`CONTEXT_REFRESH_MINUTES`, default 10), so
changing any of them in the web app or via `/setlevel` lands without a redeploy.

**Manager bot** (owner-only) — set `MANAGER_BOT_TOKEN` and `MANAGER_CHAT_ID`. It
responds *only* to `MANAGER_CHAT_ID` and does exactly two things:
- `/addbot` — guided: id, name, then **pick one of the web app's organisations**, then
  dev/client, then the Telegram token (that message is auto-deleted). It mints the org
  access token in the web app and starts the new bot immediately with zero subscribers.
- `/listbots`, `/removebot <id>`, `/setlevel <id> dev|client` — `/setlevel` updates the
  web token's level and hot-swaps the running bot.

Everything else about an organisation — its IMEIs, tag whitelist, ingest — is managed in
the tagexplore-web admin UI, not here.

## Config (`.env`) — process-global

- `WEB_API_BASE` — the tagexplore-web base URL (no trailing slash). Required.
- `WEB_PROVISION_TOKEN` — shared secret matching the web app's `BOT_PROVISION_TOKEN`;
  the manager bot uses it to mint/level/revoke tokens. Blank disables provisioning.
- `POLL_SECONDS` — how often to poll the web app for new discoveries (default 60).
- `SETTLE_SECONDS` — how long a bracket's content must stay unchanged before it's
  announced, so multiple readers landing in the same bracket a few seconds/minutes
  apart are reported once, complete (default 120).
- `CONTEXT_REFRESH_MINUTES` — how often to re-pull org name/level/whitelist from the
  web app (default 10).
- `LIVE_WINDOW_HOURS` / `MISSING_THRESHOLD_HOURS` — a tag counts as "missing" if seen in
  the live window (default 72h) but not the threshold window (8h).
- `HISTORY_START` — earliest date (ISO) any history query/chart reaches.
- `DATA_DIR` — base dir for `registry.json` and each bot's `data/<id>/` files
  (use `/data` on Railway).
- `MANAGER_BOT_TOKEN` / `MANAGER_CHAT_ID` — the manager bot (blank = disabled).
- `MAPBOX_TOKEN` — public Mapbox token for the 🛰 Map and 🔥 Heat features. Get one at
  [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens); the free
  tier is 50k static-image loads/month. If blank, those buttons reply with a friendly
  "not configured" message instead of crashing.

## Rendering stack

Charts (battery snapshot, battery trend) and the density heatmap are rendered via
**Plotly + Kaleido** (Python) — Node shells out to a small script in
`scripts/plotly_render.py` that reads a Plotly figure JSON from stdin and writes a PNG to
stdout. Setup is declared in `railpack.json` (adds Python 3.12 via mise + runs
`pip install plotly kaleido` as a build step). The position map is a **Mapbox Static
Images** URL with one coloured pin per tag. Both position map and heatmap require
`MAPBOX_TOKEN`.

## Deploying to Railway

1. Deploy tagexplore-web first and set its `BOT_PROVISION_TOKEN`. Create your
   organisations (and their devices/whitelists) there.
2. Push this repo to GitHub (or `railway init`).
3. **Attach a volume** (required — the container filesystem is wiped on every
   redeploy/restart; the volume holds `registry.json` and each bot's state/subscribers):
   service → **Volumes** → **New Volume** → Mount Path `/data`.
4. Set service variables: `WEB_API_BASE` (the web app's URL), `WEB_PROVISION_TOKEN`
   (matching the web app), `DATA_DIR=/data`, `MANAGER_BOT_TOKEN` / `MANAGER_CHAT_ID`,
   and (for maps/heatmap) `MAPBOX_TOKEN`.
5. `railway up` (or connect the repo for auto-deploy), then use the manager bot's
   `/addbot` to connect bots to your organisations.

No webhook or public URL is needed — every bot uses Telegram long polling, and each bot
(and the manager) has its own token so they never conflict.

On `SIGTERM`/`SIGINT` (a Railway redeploy sends `SIGTERM` to the old container), every
bot's long-poll is stopped cleanly before exit — without this, the old and new container
briefly hold the same Telegram connection open and fight over it (repeated 409 errors)
until the stale one times out server-side.
