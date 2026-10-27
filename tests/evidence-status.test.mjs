import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function replaceMissionCandidateEvidence(');
const end = html.indexOf('\nfunction renderMissionCockpit()', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({missionParcelGeometry: new Map()});
vm.runInContext(html.slice(html.indexOf('function scoreLandFit('), html.indexOf('function missionCandidateSort(')) + html.slice(start, end), context);
const summarize = context.missionEvidenceSummary;
const replaceEvidence = context.replaceMissionCandidateEvidence;

test('a scan without completeness cannot inherit an older complete screen after persistence', () => {
  const old = {id: 'kept-id', scannedAt: 'yesterday', terrainReviewStatus: 'complete',
    confidence: 0.58, qualifyingSamples: 8, flags: [], catAccess: {distanceKm: 1, maxSlopeDeg: 12}};
  const oldRoute = old.catAccess;
  const incoming = {id: 'new-id', scannedAt: 'today', qualifyingSamples: 3, flags: [], catAccess: null};
  replaceEvidence(old, incoming);
  const saved = JSON.parse(JSON.stringify(old));
  assert.equal(saved.id, 'kept-id');
  assert.equal(saved.terrainReviewStatus, 'unknown');
  assert.equal(saved.confidence, 0.58);
  assert.match(summarize(saved), /3 qualifying terrain samples · terrain completeness unknown · cat route not established/);
  assert.equal(saved.terrainReviewHistory[0].terrainReviewStatus, 'complete');
  assert.equal(saved.terrainReviewHistory[0].catAccess.distanceKm, 1);
  oldRoute.distanceKm = 99;
  assert.equal(old.terrainReviewHistory[0].catAccess.distanceKm, 1);
  assert.equal(incoming.terrainReviewStatus, undefined);
});

test('only a fresh explicit completeness value is accepted and prior history stays append-only', () => {
  const existing = {id: 'kept', terrainReviewStatus: 'complete', terrainReviewHistory: [{scannedAt: 'first'}]};
  for (const status of ['data_review', 'complete', 'unsupported', undefined]) {
    const before = JSON.parse(JSON.stringify(existing.terrainReviewHistory));
    replaceEvidence(existing, {terrainReviewStatus: status, terrainReviewHistory: []});
    assert.equal(existing.terrainReviewStatus, ['data_review', 'complete'].includes(status) ? status : 'unknown');
    assert.deepEqual(JSON.parse(JSON.stringify(existing.terrainReviewHistory.slice(0, -1))), before);
    assert.equal(existing.terrainReviewHistory.length, before.length + 1);
  }
});

test('better scans preserve manual and legacy rejected or sidelined reviews', () => {
  for (const review of [
    {verdict: 'reject', rejectReason: 'excluded', rejectedAt: 'yesterday'},
    {verdict: 'reject'},
    {verdict: 'sideline', rejectReason: 'needs records'},
    {verdict: 'advance', manualReview: {decision: 'promote', at: 'yesterday'}},
  ]) {
    const existing = {id: 'kept', ...review};
    replaceEvidence(existing, {id: 'incoming', verdict: 'advance', score: 90, qualifyingSamples: 9});
    assert.equal(existing.score, 90);
    for (const [key, value] of Object.entries(review)) assert.deepEqual(existing[key], value);
  }
  const automatic = {id: 'kept', verdict: 'sideline'};
  replaceEvidence(automatic, {verdict: 'advance'});
  assert.equal(automatic.verdict, 'advance');
  assert.ok(html.includes('replaceMissionCandidateEvidence(dupe, candidate);'));
});

test('an earlier manual promotion cannot override a fresh exclusion', () => {
  const existing = {id: 'kept', verdict: 'advance', manualReview: {decision: 'promote'}};
  replaceEvidence(existing, {verdict: 'reject', rejectReason: 'inside exclusion',
    rejectedAt: 'today', flags: ['inside_rejected_area']});
  assert.equal(existing.verdict, 'reject');
  assert.equal(existing.rejectReason, 'inside exclusion');
  assert.equal(existing.rejectedAt, 'today');
  assert.equal(existing.manualReview.source, 'scan_exclusion');
  assert.equal(existing.manualReview.automated, true);
  assert.equal(existing.manualReview.verdict, 'reject');
  assert.equal(existing.manualReviewHistory[0].before.manualReview.decision, 'promote');
});

test('replacement retains complete prior evidence without recursively nesting history', () => {
  const existing = {id: 'kept', lat: 45, lng: -112, verticalM: 170, score: 40, verdict: 'sideline',
    footprint: [[45, -112]], cellId: 'old-cell', agent: 'old-agent', elevationMinM: 100,
    elevationMaxM: 270, clusterSpanM: 200, landCheck: {status: 'matched', parcels: [{parcelId: 'P'}]},
    terrainReviewHistory: [{scannedAt: 'earliest'}]};
  const previous = JSON.parse(JSON.stringify(existing));
  const oldFootprint = existing.footprint;
  replaceEvidence(existing, {lat: 45.001, lng: -112.001, verticalM: 200, score: 50,
    footprint: [[45.001, -112.001]], verdict: 'advance', flags: []});
  delete previous.terrainReviewHistory;
  assert.deepEqual(JSON.parse(JSON.stringify(existing.terrainReviewHistory[1])), previous);
  assert.equal(existing.terrainReviewHistory[0].scannedAt, 'earliest');
  oldFootprint[0][0] = 99;
  assert.equal(existing.terrainReviewHistory[1].footprint[0][0], 45);
});

test('retained exclusions and matched land evidence keep their explanatory flags', () => {
  const existing = {id: 'kept', verdict: 'reject', flags: ['inside_rejected_area'],
    landCheck: {status: 'matched', landPath: 'permit_path'}};
  replaceEvidence(existing, {verdict: 'reject', rejectReason: 'new exclusion reason',
    rejectedAt: 'today', flags: ['parcel_status_unknown', 'legal_access_unverified']});
  assert.equal(existing.rejectReason, 'new exclusion reason');
  assert.equal(existing.rejectedAt, 'today');
  assert.ok(existing.flags.includes('inside_rejected_area'));
  assert.ok(existing.flags.includes('public_land_requires_permission'));
  assert.ok(existing.flags.includes('legal_access_unverified'));
  assert.ok(!existing.flags.includes('parcel_status_unknown'));
});

test('legacy percentages do not imply complete evidence or legal access', () => {
  for (const confidence of [0.35, 0.58, undefined]) {
    const record = Object.freeze({ confidence, qualifyingSamples: 6, flags: [] });
    const before = JSON.stringify(record);
    const label = summarize(record);
    assert.match(label, /6 qualifying terrain samples/);
    assert.match(label, /terrain completeness unknown/);
    assert.match(label, /cat route not established/);
    assert.match(label, /legal access unverified/);
    assert.doesNotMatch(label, /%|confidence/i);
    assert.equal(JSON.stringify(record), before);
  }
});

test('modeled access is distinct from incomplete terrain and rights', () => {
  const label = summarize({qualifyingSamples: 3, terrainReviewStatus: 'data_review',
    catAccess: {distanceKm: 1.2, maxSlopeDeg: 17}, flags: []});
  assert.match(label, /terrain data incomplete/);
  assert.match(label, /cat route modeled/);
  assert.match(label, /legal access unverified/);
});

test('an incomplete coverage flag takes precedence over a completed screen', () => {
  assert.match(summarize({qualifyingSamples: 2, terrainReviewStatus: 'complete',
    flags: ['terrain_coverage_incomplete']}), /terrain data incomplete/);
  assert.match(summarize({qualifyingSamples: 2, terrainReviewStatus: 'complete',
    flags: []}), /bounded terrain screen complete/);
});

test('missing or invalid stored values stay unknown', () => {
  assert.match(summarize({qualifyingSamples: 1}), /1 qualifying terrain sample ·/);
  for (const count of [undefined, null, -1, NaN, '5', 1.5]) {
    assert.match(summarize({qualifyingSamples: count}), /sample count unknown/);
  }
  for (const route of [undefined, {}, {distanceKm: 0, maxSlopeDeg: 18},
    {distanceKm: 1, maxSlopeDeg: NaN}, {distanceKm: '1', maxSlopeDeg: 18}]) {
    assert.match(summarize({catAccess: route}), /cat route not established/);
  }
});

test('cards use escaped evidence labels and no new fixed confidence is assigned', () => {
  assert.ok(html.includes('${escapeHtml(missionEvidenceSummary(c))}'));
  assert.doesNotMatch(html, /confidence\s*:|Confidence \$\{/);
});

test('all inline JavaScript parses', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});
