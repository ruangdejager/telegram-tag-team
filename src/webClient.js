import { appConfig } from './config.js';
import { epochToJhb } from './utils.js';

// The bot's single window onto the tagexplore-web app. It NEVER touches the
// Farmranger logs any more — the web app scrapes, parses and stores everything;
// the bot only reads it back over HTTP, scoped to one organisation by a bearer
// token, and rebuilds the "session" objects the rest of the bot already speaks.

function base() {
  return appConfig.webApiBase.replace(/\/$/, '');
}

// A 20s cap: at hourly cadence a hung fetch was invisible, but the fast poll cycle
// fans out sequentially across every running bot (botManager.pollAll), so one stuck
// request would otherwise stall every other bot's poll behind it.
const FETCH_TIMEOUT_MS = 20_000;

async function getJson(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error || msg; } catch { /* keep raw */ }
    throw new Error(`Web API ${res.status} for ${url}: ${msg}`);
  }
  return JSON.parse(text);
}

// A per-bot read client, bound to that bot's org-scoped access token.
export function createWebClient(apiToken) {
  if (!apiToken) throw new Error('createWebClient: missing apiToken');

  // { orgId, orgName, level, tags: [{ tagId, label, ... }] }
  async function fetchContext() {
    return getJson(`${base()}/api/bot/context`, apiToken);
  }

  // Raw readings + rounds for [fromMs, toMs]. Returns { readings, rounds }.
  async function fetchReadings(fromMs, toMs) {
    const url = `${base()}/api/bot/readings?from=${fromMs}&to=${toMs}`;
    const { readings, rounds } = await getJson(url, apiToken);
    return { readings: readings || [], rounds: rounds || [] };
  }

  return { fetchContext, fetchReadings };
}

// The shared-secret provisioning client the manager bot uses to attach a new bot
// to an org and set its dev/client level. One instance, authed by the process's
// WEB_PROVISION_TOKEN — nothing per-bot about it.
export function createProvisionClient() {
  const token = appConfig.webProvisionToken;
  function ensure() {
    if (!appConfig.webApiBase || !token) {
      throw new Error('Provisioning not configured — set WEB_API_BASE and WEB_PROVISION_TOKEN.');
    }
  }

  async function send(method, path, body) {
    ensure();
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(json.error || `Provision API ${res.status}: ${text.slice(0, 200)}`);
    return json;
  }

  return {
    listOrgs: () => send('GET', '/api/provision/orgs').then((r) => r.orgs || []),
    listTokens: () => send('GET', '/api/provision/tokens').then((r) => r.tokens || []),
    // -> { id, token, orgId, level, label }
    mintToken: (orgId, level, label) => send('POST', '/api/provision/tokens', { orgId, level, label }),
    setLevel: (id, level) => send('PATCH', `/api/provision/tokens/${id}`, { level }),
    deleteToken: (id) => send('DELETE', `/api/provision/tokens/${id}`),
  };
}

// Rebuilds discovery "sessions" from raw DB rows, in the exact shape the old
// sessionMerger produced from parsed logs — so formatter/analytics/maps/etc. all
// keep working untouched. The web app already rounded each reading to its bracket
// (readings.bracket_at), so grouping is a plain bucket-by-bracket with no rounding.
export function buildSessionsFromReadings(readings, rounds) {
  const roundsByBracket = new Map(); // bracket_at -> [round row]
  for (const r of rounds) {
    if (!roundsByBracket.has(r.bracket_at)) roundsByBracket.set(r.bracket_at, []);
    roundsByBracket.get(r.bracket_at).push(r);
  }

  const byBracket = new Map(); // bracket_at -> [reading row]
  for (const row of readings) {
    if (!byBracket.has(row.bracket_at)) byBracket.set(row.bracket_at, []);
    byBracket.get(row.bracket_at).push(row);
  }

  return [...byBracket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bracketAt, rows]) => bucketToSession(bracketAt, rows, roundsByBracket.get(bracketAt) || []));
}

function bucketToSession(bracketAt, rows, roundRows) {
  const { date: bracketDate, time: bracketTime, iso } = epochToJhb(bracketAt);

  const tagById = new Map();
  const perDeviceTagIds = {}; // imei -> Set of tag ids
  for (const row of rows) {
    const imei = row.device_imei;
    if (!perDeviceTagIds[imei]) perDeviceTagIds[imei] = new Set();
    perDeviceTagIds[imei].add(row.tag_id);

    const existing = tagById.get(row.tag_id);
    if (!existing) {
      tagById.set(row.tag_id, {
        id: row.tag_id,
        rssi: row.rssi,
        battery: row.battery_mv,
        hops: row.hops,
        waveCount: row.wave_count,
        movementState: row.movement_state,
        lat: row.lat,
        lon: row.lon,
        hasGps: !!row.has_gps,
        fwVersionPatch: row.fw_patch,
        gpsAgeS: row.gps_age_s,
        rssiSource: row.link_id ?? null,
        sourceUnitId: imei,
      });
    } else {
      // Per-scan fields keep whichever device saw the tag first; fw + GPS are
      // properties of the tag itself, so backfill them if the first row lacked them.
      if (existing.fwVersionPatch === null && row.fw_patch !== null) existing.fwVersionPatch = row.fw_patch;
      if ((existing.rssiSource === null || existing.rssiSource === undefined) && row.link_id != null) existing.rssiSource = row.link_id;
      if (!existing.hasGps && row.has_gps) {
        existing.hasGps = true;
        existing.lat = row.lat;
        existing.lon = row.lon;
        existing.gpsAgeS = row.gps_age_s;
      }
    }
  }

  const perDeviceTotals = {};
  for (const [imei, ids] of Object.entries(perDeviceTagIds)) perDeviceTotals[imei] = ids.size;

  const perDeviceFwVersion = {};
  for (const r of roundRows) if (r.reader_fw) perDeviceFwVersion[r.device_imei] = r.reader_fw;

  // Where a bracket holds both a pushed (CBOR) and a scraped (log) round, the pushed
  // one wins on timing — it carries the firmware's own measured duration and the
  // server's real arrival clock, both better than anything the scraped path can
  // infer from the bracket boundary. Mirrors Store.listDiscoveryCounts on the web
  // app side (apps/api/src/db/index.ts), which applies the same precedence.
  const pushedRounds = roundRows.filter((r) => r.source === 'cbor');
  const scrapedRounds = roundRows.filter((r) => r.source !== 'cbor');
  const maxDuration = (rs) => {
    const vals = rs.map((r) => r.duration_seconds).filter((v) => v != null);
    return vals.length ? Math.max(...vals) : null;
  };
  const firmwareDuration = maxDuration(pushedRounds);
  const bracketDuration = maxDuration(scrapedRounds);
  const receivedAt = pushedRounds.length
    ? Math.min(...pushedRounds.map((r) => r.received_at).filter((v) => v != null))
    : null;
  const source = pushedRounds.length ? 'cbor' : 'log';
  const durationSource = firmwareDuration != null ? 'firmware' : bracketDuration != null ? 'bracket' : null;
  const durationSeconds = firmwareDuration ?? bracketDuration ?? 0;

  // Display clock: the real arrival time for a pushed bracket, since that's a true
  // instant rather than a 15-minute bucket; the bracket's own clock otherwise, which
  // is all a scraped round has. `timestamp` (the ISO sort/de-dupe key used everywhere
  // else — history.js, missingTags.js, analytics.js, botRuntime.js's sentTimestamps
  // set) deliberately stays keyed on the bracket: an arrival-based timestamp would let
  // the same bracket reappear under a second key and be announced twice.
  const displayClock = epochToJhb(receivedAt ?? bracketAt);

  return {
    timestamp: iso,
    date: displayClock.date,
    time: displayClock.time,
    bracketDate,
    bracketTime,
    source,
    receivedAt,
    durationSource,
    discarded: false,
    involvedUnitIds: Object.keys(perDeviceTagIds),
    tags: [...tagById.values()],
    total: tagById.size,
    perDeviceTotals,
    perDeviceFwVersion,
    durationSeconds,
  };
}
