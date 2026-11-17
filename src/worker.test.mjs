// Tests for the /api/status logic. Run: node --test src/worker.test.mjs   (no npm, no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { buildStatus, dstarState, dmrState, igateState, parseMaintenance, activeMaintenance, cstToMs, lastTime } from "./worker.js";

const NOW = Date.UTC(2026, 10, 17, 18, 0, 0);
const MIN = 60000;
const instant = (v, labels) => [{ schema: { fields: [{ name: "Time" }, { name: "Value", labels: labels || {} }] }, data: { values: [[NOW], [v]] } }];
const series = (...minsAgo) => [{ schema: { fields: [{ name: "Time" }, { name: "Value" }] }, data: { values: [minsAgo.map((m) => NOW - m * MIN), minsAgo.map(() => 1)] } }];
const none = [];

test("D-Star: healthy, gateway down, controller silent, site silent", () => {
  const ok = { siteUpdate: series(5, 1), controllerAge: instant(0), gateway: instant(1), lastKeyUp: series(120), aprsSeen: series(3) };
  assert.deepEqual(dstarState(ok, NOW), { state: "on_air", detail: "Last key-up 2 h ago" });
  assert.equal(dstarState({ ...ok, gateway: instant(0) }, NOW).state, "degraded");
  assert.equal(dstarState({ ...ok, controllerAge: instant(900) }, NOW).state, "off_air");
  // site LTE down: unknown, never off_air
  assert.equal(dstarState({ ...ok, siteUpdate: series(25), controllerAge: instant(900) }, NOW).state, "unknown");
  assert.equal(dstarState({ ...ok, siteUpdate: none }, NOW).state, "unknown");
});

test("DMR: linked, one slot, not heard, poller silent", () => {
  const ok = { pollerUpdate: series(1), bmAge: instant(40), slots: instant(4, { st: "Both Slots Linked" }) };
  assert.equal(dmrState(ok, NOW).state, "on_air");
  assert.deepEqual(dmrState({ ...ok, slots: instant(4, { st: "Slot 1 Linked" }) }, NOW), { state: "degraded", detail: "Slot 1 Linked" });
  assert.equal(dmrState({ ...ok, bmAge: instant(3600) }, NOW).state, "off_air");
  assert.equal(dmrState({ ...ok, pollerUpdate: series(30) }, NOW).state, "unknown");
});

test("iGate: beaconing, silent with monitor up, silent with monitor down", () => {
  const p = { beacons45m: instant(2), lastBeacon: series(10), lastGated: series(90) };
  assert.deepEqual(igateState(p, NOW, true), { state: "on_air", detail: "Last packet gated 2 h ago" });
  const quiet = { beacons45m: none, lastBeacon: series(70), lastGated: none };
  assert.equal(igateState(quiet, NOW, true).state, "off_air");
  assert.equal(igateState(quiet, NOW, false).state, "unknown");
});

test("lastTime ignores zero counts", () => {
  const f = [{ schema: {}, data: { values: [[NOW - 5 * MIN, NOW - MIN], [3, 0]] } }];
  assert.equal(lastTime(f), NOW - 5 * MIN);
});

test("maintenance: parse, CST times, active window, open-ended", () => {
  const yml = `# comment\nevents:\n  - station: "WA0RC-B"\n    start-datetime: "2026-11-17"\n    stop-datetime: "2026-11-17 13:00:00"\n    description: "Antenna work"\n  - repeater: "KD0JWD"\n    start-datetime: "2026-11-18"\n`;
  const e = parseMaintenance(yml);
  assert.equal(e.length, 2);
  assert.equal(e[0].description, "Antenna work");
  assert.equal(cstToMs("2026-11-17 13:00:00"), Date.UTC(2026, 10, 17, 19, 0, 0));
  assert.equal(activeMaintenance(e, "WA0RC-B", NOW).description, "Antenna work"); // 12:00 CST
  assert.equal(activeMaintenance(e, "WA0RC-B", NOW + 2 * 3600 * 1000), null);
  assert.equal(activeMaintenance(e, "KD0JWD", NOW), null);
  assert.ok(activeMaintenance(e, "KD0JWD", NOW + 86400 * 1000 * 2));
  assert.deepEqual(parseMaintenance("# x\nevents: []\n"), []);
});

test("buildStatus: upstream failure is unknown, maintenance overrides", async () => {
  const env = { ASSETS: { fetch: async () => new Response(`events:\n  - station: "KD0JWD-5"\n    start-datetime: "2026-11-01"\n    description: "Moving antenna"\n`) } };
  const fetchFn = async (url) => {
    if (url.includes("dmr.")) return new Response("bad gateway", { status: 502 });
    return new Response(JSON.stringify({ results: { A: { frames: url.includes("dstar.") ? series(1) : instant(1) } } }));
  };
  const s = await buildStatus(env, fetchFn, NOW);
  assert.equal(s.stations.KD0JWD.state, "unknown");
  assert.equal(s.stations.KD0JWD.reason, "upstream");
  assert.deepEqual([s.stations["KD0JWD-5"].state, s.stations["KD0JWD-5"].detail], ["maintenance", "Moving antenna"]);
  assert.equal(s.stations["KD0JWD-5"].dashboard, "https://igate.wa0rc.org/");
  assert.ok(s.generated_at);
});
