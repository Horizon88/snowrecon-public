import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function setup(candidate) {
  const requests = [], effects = {saved: 0, rendered: 0, drawn: 0};
  const mission = {candidates: [candidate]};
  const context = vm.createContext({reconMission: mission, missionLandBatch: null, missionParcelGeometry: new Map(), missionLandRequests: new WeakMap(),
    fetchOfficialLandParcels: (lat, lng) => new Promise((resolve, reject) => requests.push({lat, lng, resolve, reject})),
    missionCandidateSort: () => 0, saveReconMission: () => { effects.saved++; return true; },
    renderMissionCockpit: () => effects.rendered++, drawMissionCandidates: () => effects.drawn++});
  const a = html.indexOf('async function checkMissionCandidateLand(');
  const b = html.indexOf('\nasync function checkMissionLand()', a);
  const c = html.indexOf('function replaceMissionCandidateEvidence(');
  const d = html.indexOf('\nfunction renderMissionCockpit()', c);
  assert.ok(a >= 0 && b > a && c >= 0 && d > c);
  vm.runInContext(html.slice(html.indexOf('function scoreLandFit('), html.indexOf('function missionCandidateSort(')) + html.slice(a, b) + '\n' + html.slice(c, d), context);
  return {context, requests, effects, mission, check: context.checkMissionCandidateLand,
    replace: context.replaceMissionCandidateEvidence};
}
const lead = () => ({id: 'lead', lat: 45, lng: -112, score: 50, verdict: 'sideline', flags: []});
const match = id => ({supported: true, checkedAt: 'today', parcels: [{parcelId: id, geometry: {type: 'Point', coordinates: [1, 2]}}]});

test('moving a lead invalidates its active match and geometry but preserves old evidence', () => {
  const candidate = {...lead(), landCheck: {status: 'matched', landPath: 'permit_path', parcels: [{parcelId: 'old'}]},
    flags: ['public_land_requires_permission', 'legal_access_unverified']};
  const s = setup(candidate); s.context.missionParcelGeometry.set('lead', ['old geometry']);
  s.replace(candidate, {lat: 45.001, lng: -112.001, score: 60, flags: []});
  assert.equal(candidate.landCheck, undefined);
  assert.equal(s.context.missionParcelGeometry.has('lead'), false);
  assert.ok(candidate.flags.includes('parcel_status_unknown'));
  assert.ok(!candidate.flags.includes('public_land_requires_permission'));
  const saved = JSON.parse(JSON.stringify(candidate));
  assert.equal(saved.terrainReviewHistory[0].landCheck.parcels[0].parcelId, 'old');
  assert.equal(saved.terrainReviewHistory[0].lat, 45);
});

test('an old-location response cannot replace a newer in-flight lookup', async () => {
  const c = lead(), s = setup(c);
  const first = s.check('lead', {silent: true});
  s.replace(c, {lat: 45.002, lng: -112.002, flags: []});
  const second = s.check('lead', {silent: true});
  const pending = c.landCheck;
  s.requests[0].resolve(match('old'));
  assert.equal(await first, null); assert.equal(c.landCheck, pending); assert.equal(s.effects.saved, 0);
  s.requests[1].resolve(match('new')); await second;
  assert.equal(c.landCheck.parcels[0].parcelId, 'new');
  assert.equal(c.landCheck.queryPosition.lat, 45.002);
  assert.equal(s.effects.saved, 1); assert.ok(s.context.missionParcelGeometry.has('lead'));
});

test('an explicitly invalidated same-position request cannot erase a newer success with an error', async () => {
  const c = lead(), s = setup(c), first = s.check('lead', {silent: true});
  c.landCheck = {...c.landCheck}; // A different pending identity invalidates the original request.
  const second = s.check('lead', {silent: true});
  s.requests[1].resolve(match('latest')); await second;
  s.requests[0].reject(new Error('late failure')); assert.equal(await first, null);
  assert.equal(c.landCheck.status, 'matched'); assert.equal(c.landCheck.parcels[0].parcelId, 'latest');
  assert.equal(s.effects.saved, 1);
});

test('a response from an old mission cannot mutate a new mission with the same lead ID', async () => {
  const c = lead(), s = setup(c), first = s.check('lead', {silent: true});
  const replacement = lead(); s.context.reconMission = {candidates: [replacement]};
  s.requests[0].resolve(match('old mission')); assert.equal(await first, null);
  assert.equal(replacement.landCheck, undefined); assert.equal(s.effects.saved, 0);
  assert.equal(s.context.missionParcelGeometry.has('lead'), false);
});

test('rechecking preserves prior evidence and clears obsolete geometry and flags on no match', async () => {
  const c = {...lead(), landCheck: {status: 'matched', parcels: [{parcelId: 'prior'}]}, flags: ['public_land_requires_permission']};
  const s = setup(c); s.context.missionParcelGeometry.set('lead', ['old']);
  const check = s.check('lead', {silent: true});
  s.requests[0].resolve({supported: true, checkedAt: 'today', parcels: []}); await check;
  assert.equal(c.landCheck.status, 'no_parcel_at_point');
  assert.equal(c.landCheckHistory[0].parcels[0].parcelId, 'prior');
  assert.ok(c.flags.includes('parcel_status_unknown')); assert.ok(!c.flags.includes('public_land_requires_permission'));
  assert.equal(s.context.missionParcelGeometry.has('lead'), false);
});

test('an unchanged position retains its current match during evidence replacement', () => {
  const c = {...lead(), landCheck: {status: 'matched', parcels: [{parcelId: 'same'}]}};
  const s = setup(c), original = c.landCheck;
  s.replace(c, {lat: 45, lng: -112, score: 60, flags: []});
  assert.equal(c.landCheck, original); assert.equal(c.terrainReviewHistory[0].landCheck.parcels[0].parcelId, 'same');
});


test('moving a rejected lead retains the decision without claiming the new point is excluded', () => {
  const c = {...lead(), verdict: 'reject', rejectReason: 'area exclusion', flags: ['inside_rejected_area']};
  const s = setup(c);
  s.replace(c, {lat: 45.002, lng: -112.002, verdict: 'sideline', flags: []});
  assert.equal(c.verdict, 'reject');
  assert.ok(!c.flags.includes('inside_rejected_area'));
  assert.ok(c.flags.includes('prior_area_rejection_retained'));
  assert.ok(c.terrainReviewHistory[0].flags.includes('inside_rejected_area'));
  s.replace(c, {lat: 45.003, lng: -112.003, verdict: 'sideline', flags: []});
  assert.equal(c.verdict, 'reject');
  assert.ok(c.flags.includes('prior_area_rejection_retained'));
  s.replace(c, {lat: 45.004, lng: -112.004, verdict: 'reject', flags: ['inside_rejected_area']});
  assert.ok(c.flags.includes('inside_rejected_area'));
  assert.ok(!c.flags.includes('prior_area_rejection_retained'));
});

test('superseded checking markers are not archived as completed evidence', async () => {
  const c = lead(), s = setup(c);
  const first = s.check('lead', {silent: true});
  c.landCheck = {...c.landCheck};
  const second = s.check('lead', {silent: true});
  assert.equal(c.landCheckHistory, undefined);
  s.requests[0].resolve(match('old')); await first;
  s.requests[1].resolve(match('new')); await second;
  assert.equal(c.landCheckHistory, undefined);
  assert.equal(c.landCheck.parcels[0].parcelId, 'new');
});
