// wa0rc.org Worker: serves the static site (assets) and GET /api/status, the live club station
// status shown in the Club Stations card.
//
// /api/status reads the public Grafana dashboards on grafana.wa0rc.org (the same data as
// dstar.wa0rc.org, igate.wa0rc.org and dmr.wa0rc.org), reduces them to one small JSON document
// and caches it at the edge for 60 s, so visitors never call Grafana themselves.
//
// Rule: missing or stale data is "unknown", never "off_air". Only positive evidence (the site is
// reporting but the repeater is silent) makes a station "off_air".
// No dependencies, no build step: wrangler deploys this file as-is.

const CACHE_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 8000;
const MIN = 60 * 1000;

// Public dashboard tokens are public by design (they are the share links).
export const STATIONS = {
  "WA0RC-B": {
    dashboard: "https://dstar.wa0rc.org/",
    base: "https://dstar.wa0rc.org/api/public/dashboards/7ae134c103714aaa938dc3da190fb77e",
    panels: { controllerAge: 2, gateway: 3, siteUpdate: 4, lastKeyUp: 6, aprsSeen: 7 },
  },
  "KD0JWD-5": {
    dashboard: "https://igate.wa0rc.org/",
    base: "https://igate.wa0rc.org/api/public/dashboards/b04f83ddde314ff182b4cd44ac0cddda",
    panels: { beacons45m: 2, lastBeacon: 3, lastGated: 6 },
  },
  KD0JWD: {
    dashboard: "https://dmr.wa0rc.org/",
    base: "https://dmr.wa0rc.org/api/public/dashboards/bf2dbcc77fb64e3bb728ded2174d16b4",
    panels: { bmAge: 2, slots: 3, pollerUpdate: 5 },
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return statusResponse(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function statusResponse(request, env, ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL("/api/status", request.url).toString());
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const body = await buildStatus(env, fetch, Date.now());
  const response = new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

// ---- data access --------------------------------------------------------------------------

async function panel(fetchFn, base, id) {
  const r = await fetchFn(`${base}/panels/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`panel ${id}: HTTP ${r.status}`);
  const d = await r.json();
  const a = d && d.results && d.results.A;
  if (!a || a.error) throw new Error(`panel ${id}: ${a ? a.error : "no result"}`);
  return Array.isArray(a.frames) ? a.frames : [];
}

async function panels(fetchFn, station) {
  const names = Object.keys(station.panels);
  const frames = await Promise.all(names.map((n) => panel(fetchFn, station.base, station.panels[n])));
  return Object.fromEntries(names.map((n, i) => [n, frames[i]]));
}

// Value of the last row of the first frame (instant queries), or null.
export function lastValue(frames) {
  const v = frames && frames[0] && frames[0].data && frames[0].data.values;
  if (!v || v.length < 2 || !v[1].length) return null;
  const x = v[1][v[1].length - 1];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

// Latest timestamp (ms) with a value above 0 across all frames (per-minute count series), or null.
export function lastTime(frames) {
  let t = null;
  for (const f of frames || []) {
    const v = f.data && f.data.values;
    if (!v || v.length < 2) continue;
    for (let i = 0; i < v[0].length; i++) {
      if (v[1][i] > 0 && (t === null || v[0][i] > t)) t = v[0][i];
    }
  }
  return t;
}

// A label value of the first frame's value field (e.g. BrandMeister slot status), or null.
export function labelValue(frames, key) {
  const fields = frames && frames[0] && frames[0].schema && frames[0].schema.fields;
  const f = fields && fields.find((x) => x.labels && x.labels[key] !== undefined);
  return f ? f.labels[key] : null;
}

export function ago(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ---- state rules (mirror the public dashboards) ------------------------------------------------

export function dstarState(p, now) {
  const site = lastTime(p.siteUpdate);
  if (site === null || now - site > 10 * MIN) return { state: "unknown", detail: "No report from the repeater site" };
  const ctrlAge = lastValue(p.controllerAge);
  if (ctrlAge === null) return { state: "unknown", detail: "No controller data" };
  const keyUp = lastTime(p.lastKeyUp);
  const heard = keyUp !== null ? `Last key-up ${ago(now - keyUp)}` : "REF030 C";
  if (ctrlAge > 300) return { state: "off_air", detail: "Repeater controller not responding" };
  if (lastValue(p.gateway) === 0) return { state: "degraded", detail: "Internet gateway offline, local RF only" };
  return { state: "on_air", detail: heard };
}

export function dmrState(p, now) {
  const upd = lastTime(p.pollerUpdate);
  if (upd === null || now - upd > 10 * MIN) return { state: "unknown", detail: "No data from BrandMeister" };
  const age = lastValue(p.bmAge);
  if (age === null) return { state: "unknown", detail: "No data from BrandMeister" };
  if (age > 900) return { state: "off_air", detail: `Not heard by BrandMeister for ${Math.round(age / 60)} min` };
  const slots = labelValue(p.slots, "st");
  if (slots && slots !== "Both Slots Linked") return { state: "degraded", detail: slots };
  return { state: "on_air", detail: slots ? "Both slots linked" : "Linked to BrandMeister" };
}

// aprsMonitorOk: the APRS-IS monitor saw WA0RC-B recently, so silence from KD0JWD-5 is real.
export function igateState(p, now, aprsMonitorOk) {
  const beacons = lastValue(p.beacons45m);
  const gated = lastTime(p.lastGated);
  const lastBeacon = lastTime(p.lastBeacon);
  if (beacons !== null && beacons > 0) {
    return { state: "on_air", detail: gated !== null ? `Last packet gated ${ago(now - gated)}` : "Listening" };
  }
  if (!aprsMonitorOk) return { state: "unknown", detail: "APRS-IS monitor has no data" };
  return { state: "off_air", detail: lastBeacon !== null ? `Last beacon ${ago(now - lastBeacon)}` : "No beacon in 24 h" };
}

// ---- maintenance windows (events-maintenance.yml, Central Standard Time UTC-6, no DST) ---------

// Minimal reader for the schema-checked maintenance file: a list of flat "key: value" entries.
export function parseMaintenance(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    const m = line.match(/^\s*(-\s+)?([a-z-]+):\s*"?([^"]*)"?\s*$/);
    if (!m || m[2] === "events") continue;
    if (m[1]) { cur = {}; out.push(cur); }
    if (cur) cur[m[2]] = m[3];
  }
  return out;
}

export function cstToMs(value) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [h, mi, s] = m[4] ? [+m[4], +m[5], +m[6]] : [0, 1, 0];
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h + 6, mi, s);
}

export function activeMaintenance(entries, call, now) {
  return entries.find((e) => {
    const who = e.station || e.repeater;
    if (!who || who.toUpperCase() !== call) return false;
    const start = cstToMs(e["start-datetime"]);
    const stop = e["stop-datetime"] ? cstToMs(e["stop-datetime"]) : Infinity;
    return start !== null && start <= now && now <= stop;
  }) || null;
}

// ---- assemble ---------------------------------------------------------------------------------

export async function buildStatus(env, fetchFn, now) {
  let maintenance = [];
  try {
    const r = await env.ASSETS.fetch("https://assets.local/events-maintenance.yml");
    if (r.ok) maintenance = parseMaintenance(await r.text());
  } catch (_) { /* no maintenance file: nothing overridden */ }

  const results = await Promise.allSettled(Object.values(STATIONS).map((s) => panels(fetchFn, s)));
  const data = Object.fromEntries(Object.keys(STATIONS).map((c, i) => [c, results[i]]));

  const out = {};
  const calc = {
    "WA0RC-B": (p) => dstarState(p, now),
    KD0JWD: (p) => dmrState(p, now),
    "KD0JWD-5": (p) => {
      const d = data["WA0RC-B"];
      const seen = d.status === "fulfilled" ? lastTime(d.value.aprsSeen) : null;
      return igateState(p, now, seen !== null && now - seen < 45 * MIN);
    },
  };
  for (const [call, st] of Object.entries(STATIONS)) {
    const r = data[call];
    let s;
    if (r.status === "fulfilled") {
      try { s = calc[call](r.value); } catch (e) { s = { state: "unknown", detail: "Status unavailable", reason: "parse" }; }
    } else {
      s = { state: "unknown", detail: "Status unavailable", reason: "upstream" };
    }
    const m = activeMaintenance(maintenance, call, now);
    if (m) s = { state: "maintenance", detail: m.description || "Scheduled maintenance" };
    out[call] = { ...s, dashboard: st.dashboard };
  }
  return { generated_at: new Date(now).toISOString(), stations: out };
}
