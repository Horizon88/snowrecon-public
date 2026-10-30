import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
// Run the actual hydration, persistence, card renderer and parcel-check action.
// Each page() is a fresh JS realm sharing only serialized browser storage.
const source = [
  section('function escapeLandText(', 'function publicNullableNumber('),
  section('async function checkMissionCandidateLand(', 'async function checkMissionLand('),
  section('function saveReconMission(', 'async function retryMissionDataReview('),
  section('function renderMissionCockpit(', 'function drawMissionCandidates('),
].join('\n');
const copy = value => JSON.parse(JSON.stringify(value));
const lead = (id, landCheck) => ({
  id, lat: 46, lng: -112, footprint: [[46, -112], [46.001, -112.001]],
  score: 45, confidence: .58, verticalM: 260, clusterSpanM: 220, aspect: 'N',
  verdict: 'sideline', manualReview: { verdict: 'sideline', reason: 'saved decision' },
  flags: ['parcel_status_unknown'], agent: 'fixture', catAccess: { grade: 'A', distanceKm: 1, maxSlopeDeg: 10 },
  ...(landCheck === undefined ? {} : { landCheck }),
});
const mission = candidates => ({ id: 'saved-mission', name: 'Fixture', status: 'complete',
  cells: [{ id: 'complete-cell', status: 'complete' }], candidates, rejected: 0, errors: 0,
  exclusions: [{ id: 'preserve-exclusion' }], retryHistory: [{ id: 'prior-evidence' }],
});
function page(values, { failSave = false, parcelReply = async () => { throw Error('Unexpected parcel request'); } } = {}) {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, hidden: true, disabled: false, innerHTML: '', textContent: '' });
    return elements.get(id);
  };
  const context = vm.createContext({
    reconMission: null, MISSION_KEY: 'mission', missionRunning: false, missionPaused: false,
    missionStorageFailed: false, missionStopRequested: false, missionParcelGeometry: new Map(),
    document: { getElementById: element },
    localStorage: { getItem: key => values.get(key), setItem(key, value) {
      if (failSave) throw Error('QuotaExceededError');
      values.set(key, value);
    }, removeItem: key => values.delete(key) },
    fetch() { throw Error('Unexpected network'); },
    fetchOfficialLandParcels: async (lat, lng) => { calls.push({ lat, lng }); return parcelReply(); },
    drawMissionCandidates() {}, escapeHtml: value => String(value),
  });
  vm.runInContext(source, context);
  return { context, element, calls, load() { context.loadReconMission(); return context.reconMission; } };
}
const payload = () => ({ supported: true, checkedAt: 'new-fixture-check',
  provider: { name: 'Fixture provider' }, jurisdiction: { stateProvince: 'Fixture' },
  parcels: [{ parcelId: 'fixture-parcel', ownershipClass: 'private', acres: 20,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } }],
});

test('reload hydrates persisted checking as interrupted, including undisplayed leads, without moving evidence', () => {
  const candidates = Array.from({ length: 32 }, (_, i) => lead(`lead-${i}`, { status: 'matched', parcels: [] }));
  for (const i of [0, 31]) candidates[i].landCheck = { status: 'checking', checkedAt: 'original-start', retained: 'keep' };
  candidates[0].catAccess = null;
  const original = mission(candidates), values = new Map([['mission', JSON.stringify(original)]]);
  const h = page(values), state = h.load();
  assert.equal(h.calls.length, 0);
  for (const i of [0, 31]) {
    assert.equal(state.candidates[i].landCheck.status, 'error');
    assert.match(state.candidates[i].landCheck.error, /interrupted.*reload/i);
    const restored = copy(state.candidates[i]);
    restored.landCheck = original.candidates[i].landCheck;
    assert.deepEqual(restored, original.candidates[i]);
    assert.equal(state.candidates[i].landCheck.checkedAt, 'original-start');
    assert.equal(state.candidates[i].landCheck.retained, 'keep');
  }
  assert.deepEqual(copy(state.cells), original.cells);
  assert.deepEqual(copy(state.exclusions), original.exclusions);
  assert.deepEqual(copy(state.retryHistory), original.retryHistory);
  assert.equal(JSON.parse(values.get('mission')).candidates[31].landCheck.status, 'error');
  const saved = values.get('mission');
  page(values).load();
  assert.equal(values.get('mission'), saved, 'a second reload is idempotent');
});

test('reloaded interrupted card offers the existing Recheck land action at the saved coordinates', async () => {
  const original = mission([lead('recheck-source', { status: 'checking', checkedAt: 'original-start' })]);
  const values = new Map([['mission', JSON.stringify(original)]]);
  const h = page(values, { parcelReply: async () => payload() }), state = h.load();
  assert.equal(state.candidates[0].landCheck.status, 'error');
  const card = h.element('missionReports').innerHTML;
  assert.match(card, /Land check error:.*interrupted/);
  assert.doesNotMatch(card, /Checking official parcels/);
  const action = card.match(/onclick="event\.stopPropagation\(\);(checkMissionCandidateLand\('[^']+'\))"[^>]*>Recheck land<\/button>/);
  assert.ok(action, 'real rendered card retains its existing recheck action');
  await vm.runInContext(action[1], h.context);
  assert.deepEqual(h.calls, [{ lat: original.candidates[0].lat, lng: original.candidates[0].lng }]);
  assert.equal(state.candidates[0].landCheck.status, 'matched');
  assert.equal(JSON.parse(values.get('mission')).candidates[0].landCheck.status, 'matched');
  assert.deepEqual(copy(state.candidates[0].footprint), original.candidates[0].footprint);
  assert.deepEqual(copy(state.candidates[0].manualReview), original.candidates[0].manualReview);
  assert.equal(state.candidates[0].verdict, original.candidates[0].verdict);
});

test('reload leaves completed, failed, unsupported and unchecked parcel states unchanged', () => {
  const states = [undefined, null, { status: 'matched', parcels: [] }, { status: 'error', error: 'saved failure' },
    { status: 'unsupported_jurisdiction' }, { status: 'no_parcel_at_point' }];
  const original = mission(states.map((state, i) => lead(`unchanged-${i}`, state)));
  const values = new Map([['mission', JSON.stringify(original)]]), h = page(values);
  assert.deepEqual(copy(h.load()), original);
  assert.equal(h.calls.length, 0);
});

test('a current-session pending request remains checking through render/save and completes normally', async () => {
  let resolveReply;
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const original = mission([lead('active-source')]), values = new Map([['mission', JSON.stringify(original)]]);
  const h = page(values, { parcelReply: () => reply }), state = h.load();
  const pending = h.context.checkMissionCandidateLand('active-source');
  h.context.renderMissionCockpit(); h.context.saveReconMission();
  assert.equal(state.candidates[0].landCheck.status, 'checking');
  assert.equal(JSON.parse(values.get('mission')).candidates[0].landCheck.status, 'checking');
  assert.match(h.element('missionReports').innerHTML, /Checking official parcels/);
  resolveReply(payload()); await pending;
  assert.equal(state.candidates[0].landCheck.status, 'matched');
  assert.equal(JSON.parse(values.get('mission')).candidates[0].landCheck.status, 'matched');
  assert.equal(h.calls.length, 1);
});

test('recovery-save failure retains recovered memory and original saved bytes for the next reload', () => {
  const original = mission([lead('storage-source', { status: 'checking', checkedAt: 'original-start' })]);
  const initial = JSON.stringify(original), values = new Map([['mission', initial]]);
  const failed = page(values, { failSave: true }), recovered = failed.load();
  assert.equal(recovered.candidates[0].landCheck.status, 'error');
  assert.equal(values.get('mission'), initial);
  assert.equal(failed.context.missionStorageFailed, true);
  assert.equal(failed.element('missionStorageError').hidden, false);
  assert.match(failed.element('missionStorageError').textContent, /last saved mission is preserved/i);
  const next = page(values), state = next.load();
  assert.equal(state.candidates[0].landCheck.status, 'error');
  assert.equal(JSON.parse(values.get('mission')).candidates[0].landCheck.status, 'error');
  assert.deepEqual(copy(state.candidates[0].footprint), original.candidates[0].footprint);
  assert.equal(next.calls.length, 0);
});
