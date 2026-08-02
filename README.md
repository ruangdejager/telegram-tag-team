# Farmranger Tag Bot

Runs **one or more Telegram bots from a single process**, each with its own bot
token and its own set of device IMEIs. For each bot, it polls its units'
Farmranger logs, merges same-round discovery blocks across those devices into a
single session, and pushes new unique tag discoveries to that bot's Telegram
subscribers. Devices retry after a `LOG TIMEOUT` and often succeed a few seconds
later — a timed-out block is simply excluded in favor of a successful retry in
the same round; only if *no* device produced a usable reading is the round
discarded and flagged.

Each bot has a **level**: `dev` (full technical insight) or `client` (a reduced,
non-technical view — see *Bots, levels & the manager bot* below). Bots are added
and managed live through an owner-only **manager bot** — no redeploy needed.

Every bot has a `/start` menu (inline buttons) for on-demand queries. History
never reaches earlier than `HISTORY_START` (device data isn't valid before then).

## Local setup

```
npm install
cp .env.example .env   # fill in real values (a working .env is already present locally)
npm start
```

Then in Telegram, message the bot `/start` to see the menu.

`npm run test:parse`, `test:analytics`, `test:modes`, `test:retry`, and
`test:client` run the parser/merger/report formatters (including the dev-vs-client
views) against fixtures in `test/fixtures/` without touching the network — useful
for checking log-format changes before pointing at the real API.

With no registry yet, the process **seeds one bot from the legacy env vars**
(`UNIT_IDS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) as a `dev` bot named
`primary`, and migrates any old flat `data/state.json` / `data/subscribers.json`
into `data/primary/`. After that the registry (`data/registry.json`) is the
source of truth and those env vars are ignored.

### Log format

Each device reports in one of two modes, self-described by a CSV header line
under `Tag Discovery (advanced):` or `Tag Discovery (basic):` — column order
and field set are read from that header, not hardcoded, since they've already
changed between firmware versions:
- **advanced**: `DeviceId,Hops,Wave,RSSI,BatMv,Move,Lat,Lon,FwPatch`
- **basic**: `DeviceId,BatMv,RSSI,Move,FwPatch,Lat,Lon,AgeS` (no Hops/Wave;
  `AgeS` = seconds since the GPS fix was taken)

Different devices can run different modes simultaneously — merged session
tables only show the Hops/Waves/FW columns if at least one tag in that session
actually has a value for them. GPS is always shown as Y/N, never raw
coordinates. Logs predating this header convention fall back to the original
known column order.

## Features

- **Live push**: every new merged discovery session is sent to everyone who
  tapped "Opt In" for that bot, as soon as it's detected. No chat is
  pre-subscribed — every bot starts with zero subscribers, including you;
  message the bot `/start` and tap Opt In to receive its live updates.
- **LOG TIMEOUT handling**: a device that times out often retries and succeeds
  a few seconds later in the same round — the failed block is simply excluded
  and the successful retry is used. Only when *no* device produced a usable
  reading for the round is it discarded and a warning sent instead of data.
- **Discovery duration**: shown as `Discovery took Ns` on every session,
  assuming the round started exactly at its 15-minute bracket boundary
  (`MERGE_BRACKET_MINUTES`) — the longest time any one device took to produce
  its successful reading.
- **`/start` menu** (button labels kept short for mobile — full names below):
  - 📋 Latest / 4h / 24h — raw per-session tag tables. Raw views also append
    any **missing tags** (seen in the last `LIVE_WINDOW_HOURS` but not in the
    last `MISSING_THRESHOLD_HOURS`).
  - 📊 1d / 3d / 7d — daily summaries, showing **total discoveries that day**,
    **combined unique tag count per discovery** (deduped across all devices)
    alongside each device's own count, plus the day's full unique-tag roll-up.
  - 🔍 Missing — same missing-tags list on demand.
  - 📍 GPS — prompts for a tag ID, returns its last known GPS fix as a Google
    Maps link.
  - 🔋 Battery — full-fleet snapshot chart (latest reading per tag).
  - 📉 Trend — prompts for one or more tag IDs, returns a battery-over-time
    line chart for just those tags over the last 7 days (one line per tag).
    Readings are time-bucketed to stay under QuickChart's data-point limit
    regardless of how often a tag actually reports.
  - ✅/❌ Opt in/out of live push updates.
- **Text commands** (dev): `/battery ID [ID ...]` (7-day trend chart, one or
  more tags), `/gps ID`, `/missing`. On client bots `/battery` is disabled.

## Bots, levels & the manager bot

Every bot is a registry entry: `{ id, name, token, level, unitIds, adminChatId }`,
stored in `data/registry.json` on the volume. All bots run in one process and
share the same hourly poll tick; each keeps its own `lastProcessedTimestamp` and
subscriber list under `data/<id>/`, so two bots pointing at the same IMEIs push
independently.

**Levels** change only what a bot shows:
- `dev` — everything above (full raw tables with RSSI/hops/waves/mov/FW +
  discovery duration + per-device/IMEI breakdown, daily summaries with per-device
  columns and the day's tag-ID list, plus the Trend chart).
- `client` — raw discovery (Latest/4h/24h) and live push show **only Tag ID,
  Battery mV, GPS Y/N** plus the combined unique total (no FW, no IMEIs, no
  duration); summaries show **Time + Combined only** (no per-device column, no
  tag-ID list); the **Trend** feature is removed. Missing, GPS lookup, Battery
  chart and Opt in/out are unchanged.

**Manager bot** (owner-only) — set `MANAGER_BOT_TOKEN` and `MANAGER_CHAT_ID`. It
responds *only* to `MANAGER_CHAT_ID` and drives the registry live (no redeploy):
- `/addbot` — guided: id, name, level, IMEIs, then the token (that message is
  auto-deleted). Starts the new bot immediately with zero subscribers — message
  the new bot and tap Opt In to start receiving its updates.
- `/listbots`, `/removebot <id>`, `/addimei <id> <imei>`, `/removeimei <id> <imei>`,
  `/setlevel <id> dev|client` — IMEI/level changes restart just that bot.

## Config (`.env`) — process-global

- `MERGE_BRACKET_MINUTES` — discovery timestamps are rounded to the nearest
  bracket of this many minutes (default 15). Every block that rounds to the same
  bracket — any device, even repeats from the same device — becomes one session.
- `POLL_MINUTE` — minute past the hour on which to poll (default 20). Farmranger
  uploads at :15; polling at :20 catches a fresh upload with a small margin.
- `LIVE_WINDOW_HOURS` / `MISSING_THRESHOLD_HOURS` — a tag counts as "missing"
  if seen in the live window (default 72h) but not the threshold window (8h).
- `HISTORY_START` — earliest date (ISO) any history query/chart reaches.
- `DATA_DIR` — base dir for `registry.json` and each bot's `data/<id>/` files
  (use `/data` on Railway).
- `MANAGER_BOT_TOKEN` / `MANAGER_CHAT_ID` — the manager bot (blank = disabled).
- Legacy seed (optional): `UNIT_IDS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  (+ optional `LEGACY_BOT_ID`/`_NAME`/`_LEVEL`) seed one bot when the registry
  is empty; ignored once `registry.json` exists.

## Deploying to Railway

1. Push to a GitHub repo (or `railway init`).
2. **Attach a volume** (required — the container filesystem is wiped on every
   redeploy/restart; the volume holds `registry.json`, so without it every bot,
   subscriber list and push position is lost): service → **Volumes** →
   **New Volume** → Mount Path `/data`.
3. Set service variables: the process-global vars above, `DATA_DIR=/data`, and
   `MANAGER_BOT_TOKEN`/`MANAGER_CHAT_ID`. For the very first bot you can either
   set the legacy seed vars or just add it via the manager bot after deploy.
4. `railway up` (or connect the repo for auto-deploy), then use the manager bot
   to add your bots.

No webhook or public URL is needed — every bot uses Telegram long polling, and
each bot (and the manager) has its own token so they never conflict.

On `SIGTERM`/`SIGINT` (a Railway redeploy sends `SIGTERM` to the old container),
every bot's long-poll is stopped cleanly before exit — without this, the old and
new container briefly hold the same Telegram connection open and fight over it
(repeated 409 errors) until the stale one times out server-side.
