import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const engineSource = await readFile(new URL('../run-engine.js', import.meta.url), 'utf8');
const workerSource = html.slice(html.indexOf('async function runMissionWorker('), html.indexOf('function toggleMissionPause('));
const fixtures = () => [500, 400, 350, 260, 200, 150, 149].map((maxVert, i) => ({
  maxVert, width: 200, pointCount: 6, maxElev: 1800, minElev: 1800 - maxVert,
  centroidLat: 46 + i * .02, centroidLng: -112, aspectDir: 'N',
  points: [{ lat: 46 + i * .02, lng: -112, elevation: 1800 }, { lat: 46 + i * .02 + .002, lng: -112, elevation: 1800 - maxVert }],
}));
async function run({ roads = true, excludedLat = null, candidates = [], complete = true, zones = fixtures(), routeDistance = 1000, routeSlope = 12 } = {}) {
  const engineContext = vm.createContext({ fetch() { throw Error('Unexpected network'); }, setTimeout, clearTimeout });
  vm.runInContext(`${engineSource}\nglobalThis.engine = RunEngine;`, engineContext);
  const cell = { id: 'cell', bounds: {}, status: 'pending', attempts: 0 };
  const state = { cells: [cell], candidates, rejected: 0, errors: 0, minElevation: 250 };
  const calls = { scans: 0, road: 0, routes: [], land: [], landTargets: [], saves: [] };
  const context = vm.createContext({ setTimeout, missionStopRequested: false, missionPaused: false,
    missionStorageFailed: false, currentRegion: 'usa', reconMission: state,
    RunEngine: { setZoneSensitivity() {}, scanZones: async () => { calls.scans++; return { samples: [], coverage: { complete } }; },
      clusterZones: () => zones, screenMissionZones: engineContext.engine.screenMissionZones,
      fetchRoads: async () => { calls.road++; return roads ? [{}] : []; },
      traceCatRoute: async (lat) => { calls.routes.push(lat); return { reachedTarget: true, distance: routeDistance, maxSlope: routeSlope, points: [{}, {}, {}], elevGain: 400 }; } },
    saveReconMission() { calls.saves.push(JSON.parse(JSON.stringify(state))); return true; },
    renderMissionCockpit() {}, drawMissionCandidates() {}, missionCandidateSort: () => 0,
    missionHash: (lat, lng) => `${lat}:${lng}`,
    findMissionExclusion: (lat) => lat === excludedLat ? { reason: 'preserved exclusion' } : null,
    missionDistanceM: (a, b) => Math.abs(a.lat - b.lat) * 111320,
    checkMissionCandidateLand: async id => { calls.land.push(id); const candidate = state.candidates.find(c => c.id === id); calls.landTargets.push({ id, lat: candidate.lat, lng: candidate.lng }); },
  });
  vm.runInContext(workerSource, context); await context.runMissionWorker('fixture-agent');
  assert.equal(state.errors, 0); return { state, cell, calls };
}

test('all six screened zones survive into saved state, including the fourth and 150m lead', async () => {
  const { state, cell, calls } = await run();
  assert.deepEqual(state.candidates.map(c => c.verticalM), [500, 400, 350, 260, 200, 150]);
  assert.deepEqual(calls.saves.at(-1).candidates.map(c => c.verticalM), [500, 400, 350, 260, 200, 150]);
  assert.equal(cell.leads, 6); assert.equal(cell.status, 'complete');
});
test('retention keeps one scan/road fetch and at most three automatic route and parcel checks', async () => {
  const { state, calls } = await run();
  assert.equal(calls.scans, 1); assert.equal(calls.road, 1);
  assert.deepEqual(calls.routes, fixtures().slice(0, 3).map(z => z.centroidLat));
  assert.equal(calls.land.length, 3);
  for (const c of state.candidates.slice(3)) { assert.equal(c.researchPending, true); assert.ok(c.flags.includes('research_deferred')); assert.equal(c.catAccess, null); }
  for (const c of state.candidates.slice(0, 3)) assert.equal(c.researchPending, false);
});
test('missing roads retain every zone with unresolved access and bounded parcel work', async () => {
  const { state, calls } = await run({ roads: false });
  assert.equal(state.candidates.length, 6); assert.equal(calls.routes.length, 0); assert.equal(calls.land.length, 3);
  assert.ok(state.candidates.every(c => c.catAccess === null));
});
test('a deferred zone inside a prior exclusion remains rejected', async () => {
  const { state, calls } = await run({ excludedLat: fixtures()[4].centroidLat });
  const c = state.candidates.find(c => c.lat === fixtures()[4].centroidLat);
  assert.ok(c); assert.equal(c.verdict, 'reject'); assert.equal(c.rejectReason, 'preserved exclusion');
  assert.ok(c.flags.includes('inside_rejected_area')); assert.ok(!calls.land.includes(c.id));
});
test('deferred duplicate leaves its existing identity and explicit user rejection unchanged', async () => {
  const old = { id: 'existing-source', lat: fixtures()[4].centroidLat, lng: -112, score: 0,
    verdict: 'reject', rejectReason: 'user decision', rejectedAt: 'saved-date', manualReview: { note: 'keep' },
    landCheck: { status: 'saved' }, verticalM: 175 };
  const before = JSON.parse(JSON.stringify(old));
  const { state, calls } = await run({ candidates: [old] });
  assert.equal(state.candidates.length, 6); assert.deepEqual(old, before);
  assert.equal(old.id, 'existing-source'); assert.equal(old.verdict, 'reject'); assert.equal(old.rejectReason, 'user decision');
  assert.equal(old.rejectedAt, 'saved-date'); assert.deepEqual(old.manualReview, { note: 'keep' });
  assert.deepEqual(old.landCheck, { status: 'saved' }); assert.ok(!calls.land.includes(old.id));
});
test('all retained zones keep incomplete-terrain evidence instead of promoting the cell', async () => {
  const { state, cell } = await run({ complete: false });
  assert.equal(state.candidates.length, 6); assert.equal(cell.status, 'data_review'); assert.equal(state.rejected, 0);
  assert.ok(state.candidates.every(c => c.terrainReviewStatus === 'data_review' && c.flags.includes('terrain_coverage_incomplete')));
});

test('deferred higher-score variant preserves routed parcel-matched evidence at its original geometry', async () => {
  const old = { id: 'enriched-source', lat: fixtures()[4].centroidLat - .002, lng: -112, score: 1,
    verdict: 'advance', confidence: .58, verticalM: 175,
    footprint: [[45.9, -112], [45.901, -112]],
    catAccess: { distanceKm: 1.2, maxSlopeDeg: 15, grade: 'A' },
    landCheck: { status: 'matched', parcelId: 'public-fixture', sourcePosition: 'original' },
    flags: ['public_land_requires_permission'], researchPending: false };
  const before = JSON.parse(JSON.stringify(old));
  const { state, calls } = await run({ candidates: [old] });
  assert.equal(state.candidates.length, 6); assert.deepEqual(old, before);
  assert.ok(!calls.land.includes(old.id));
  assert.deepEqual(calls.saves.at(-1).candidates.find(c => c.id === old.id), before);
});

function sameCellCollision() {
  const zones = fixtures().slice(0, 4);
  zones.forEach((z, i) => { z.maxVert = 500 - i * 10; z.minElev = z.maxElev - z.maxVert; });
  Object.assign(zones[0], { pointCount: 1, maxElev: 750, minElev: 250 });
  zones[0].points = [{ lat: zones[0].centroidLat, lng: -112, elevation: 750 }];
  zones[3].centroidLat = zones[0].centroidLat + .002;
  zones[3].points = [{ lat: zones[3].centroidLat, lng: -112, elevation: 1800 }];
  return zones;
}

test('same-cell deferred variant cannot move an enriched candidate before its queued parcel check', async () => {
  const zones = sameCellCollision();
  // First lead's long valid route earns zero access points; the deferred variant
  // has greater terrain-only score and would have replaced it before M1 repair.
  const { state, calls } = await run({ zones, routeDistance: 6900, routeSlope: 24 });
  const id = `${zones[0].centroidLat}:-112`, first = state.candidates.find(c => c.id === id);
  assert.equal(state.candidates.length, 3); assert.equal(first.lat, zones[0].centroidLat);
  assert.equal(first.verticalM, 500); assert.equal(first.catAccess.distanceKm, 6.9);
  assert.equal(first.verdict, 'advance'); assert.equal(first.confidence, .58); assert.equal(first.researchPending, false);
  assert.ok(!first.flags.includes('research_deferred'));
  assert.deepEqual(calls.landTargets.find(c => c.id === id), { id, lat: zones[0].centroidLat, lng: -112 });
  assert.equal(calls.routes.length, 3); assert.equal(calls.land.length, 3);
});

test('same-cell queued parcel target is preserved even without a modeled route or existing parcel result', async () => {
  const zones = sameCellCollision(), { state, calls } = await run({ zones, roads: false });
  const id = `${zones[0].centroidLat}:-112`, first = state.candidates.find(c => c.id === id);
  assert.equal(state.candidates.length, 3); assert.equal(first.lat, zones[0].centroidLat);
  assert.equal(first.verticalM, 500); assert.equal(first.catAccess, null); assert.equal(first.landCheck, undefined);
  assert.equal(first.researchPending, false); assert.ok(!first.flags.includes('research_deferred'));
  assert.deepEqual(calls.landTargets.find(c => c.id === id), { id, lat: zones[0].centroidLat, lng: -112 });
  assert.equal(calls.routes.length, 0); assert.equal(calls.land.length, 3);
});
