# Farmranger Tag Bot

Polls Farmranger unit logs for one or more devices, merges same-round discovery
blocks across devices into a single session, and pushes new unique tag
discoveries to Telegram. Devices retry after a `LOG TIMEOUT` and often succeed
a few seconds later — a timed-out block is simply excluded in favor of a
successful retry in the same round; only if *no* device produced a usable
reading is the round discarded and flagged.

Also has a `/start` menu (inline buttons) for on-demand queries: raw 4h/24h
data, 3-day/7-day daily summaries, a battery chart, and opt-in/out of live
push updates. History never reaches earlier than `HISTORY_START` (device data
isn't valid before then).

## Local setup

```
npm install
cp .env.example .env   # fill in real values (a working .env is already present locally)
npm start
```

Then in Telegram, message the bot `/start` to see the menu.

`npm run test:parse`, `npm run test:analytics`, `npm run test:modes`, and
`npm run test:retry` run the parser/merger/report formatters against fixtures
in `test/fixtures/` without touching the network — useful for checking
log-format changes before pointing at the real API.

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

- **Live push**: every new merged discovery session is sent to all subscribers
  (admin chat + anyone who tapped "Opt In") as soon as it's detected.
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
- **Text commands**: `/battery ID [ID ...]` (7-day trend chart, one or more
  tags), `/gps ID`, `/missing`.

## Config (`.env`)

- `UNIT_IDS` — comma-separated device IDs to poll and merge.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — admin chat, always subscribed.
- `MERGE_BRACKET_MINUTES` — discovery timestamps are rounded to the nearest
  bracket of this many minutes (default 15, e.g. 12:00, 12:15, 12:30, ...).
  Every block that rounds to the same bracket — any device, even multiple
  blocks from the same device — becomes one session.
- `POLL_MINUTE` — minute past the hour on which to poll (default 20). Farmranger
  uploads at :15 past every hour; polling at :20 catches a fresh upload with a
  small safety margin and no wasted requests.
- `LIVE_WINDOW_HOURS` / `MISSING_THRESHOLD_HOURS` — a tag counts as "missing"
  if it was seen in the live window (default 72h) but not in the threshold
  window (default 8h).
- `STATE_FILE` — where `lastProcessedTimestamp` is persisted so restarts don't
  resend history.
- `SUBSCRIBERS_FILE` — where extra opted-in chat IDs are persisted.
- `HISTORY_START` — earliest date (ISO, e.g. `2026-06-20`) any history query or
  chart will look back to, since device data isn't valid before it. Change this
  if the valid range ever moves — no code change needed, just update the env
  var (a Railway service variable in production, or `.env` locally) and
  restart.

## Deploying to Railway

1. Push this project to a GitHub repo, or `railway init` from this directory.
2. Set the env vars from above as Railway service variables (do **not** commit
   `.env`), with `STATE_FILE=/data/state.json` and
   `SUBSCRIBERS_FILE=/data/subscribers.json`.
3. **Attach a volume** (required — Railway's container filesystem is wiped on
   every redeploy/restart otherwise, which would resend the whole day's
   history and forget subscribers):
   - Railway dashboard → your service → **Volumes** tab → **New Volume**.
   - Set **Mount Path** to `/data`.
   - Redeploy so the service picks up the mounted, persistent `/data`.
4. `railway up` (or connect the GitHub repo for auto-deploy).

With the volume attached, `lastProcessedTimestamp` and the subscriber list
survive restarts, redeploys, and crashes — the bot picks up exactly where it
left off instead of replaying history or losing opt-ins.

No webhook or public URL is needed — the bot uses Telegram long polling.
