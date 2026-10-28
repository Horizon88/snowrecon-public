import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const elements = new Map();
const context = vm.createContext({missionPersistence:{unsaved:false,archiveWarning:'',notice:''},missionParcelGeometry: new Map(), missionPaused: false,
  document: {getElementById: id => {if (!elements.has(id)) elements.set(id, {style: {}, innerHTML: ''}); return elements.get(id);}}});
const start = html.indexOf('function replaceMissionCandidateEvidence(');
const end = html.indexOf('\nfunction drawMissionCandidates()', start);
vm.runInContext(html.slice(html.indexOf('function escapeHtml('), html.indexOf('function applyMissionPreset(')) + html.slice(html.indexOf('function escapeLandText('), html.indexOf('function publicNullableNumber(')) + html.slice(start, end), context);
const replace = context.replaceMissionCandidateEvidence;
const lead = () => ({id:'same', lat:45, lng:-112, verdict:'sideline', score:80, verticalM:400,
  flags:[], catAccess:{grade:'A', distanceKm:1, maxSlopeDeg:12},
  landCheck:{status:'matched', checkedAt:'2026-10-20T00:00:00Z', queryPosition:{lat:45,lng:-112},
    provider:{name:'Retained official parcel source'}, parcels:[{parcelId:'fixture-private',ownershipClass:'private',acres:160}],
    landPath:'purchase_lead', score25:25, combinedScore:85, legalAccess:'unverified', titleVerified:false}});

test('same-position terrain changes refresh real parcel fit and preserve dated source and old score', () => {
  const c=lead(); const parcel=c.landCheck.parcels[0], source=c.landCheck.provider;
  replace(c,{lat:45,lng:-112,score:90,verticalM:200,catAccess:null,flags:[]});
  assert.equal(c.landCheck.landPath,'private_followup');
  assert.equal(c.landCheck.combinedScore,93);
  assert.equal(c.landCheck.checkedAt,'2026-10-20T00:00:00Z');
  assert.equal(c.landCheck.parcels[0],parcel); assert.equal(c.landCheck.provider,source);
  assert.equal(c.landCheck.legalAccess,'unverified'); assert.equal(c.landCheck.titleVerified,false);
  assert.ok(c.landCheck.fitUpdatedAt);
  const saved=JSON.parse(JSON.stringify(c));
  assert.equal(saved.terrainReviewHistory[0].landCheck.combinedScore,85);
  assert.equal(saved.terrainReviewHistory[0].landCheck.landPath,'purchase_lead');
  replace(c,{lat:45,lng:-112,score:100,verticalM:400,catAccess:{grade:'B'},flags:[]});
  assert.equal(c.landCheck.landPath,'purchase_lead'); assert.equal(c.landCheck.combinedScore,100);
  assert.equal(c.terrainReviewHistory[1].landCheck.landPath,'private_followup');
});

test('public source remains a permit research path with refreshed fit and retained rejection', () => {
  const c=lead();c.verdict='reject';c.rejectReason='Retained review';c.landCheck.parcels[0].ownershipClass='public';
  replace(c,{lat:45,lng:-112,score:40,verdict:'advance',flags:[]});
  assert.equal(c.verdict,'reject'); assert.equal(c.rejectReason,'Retained review');
  assert.equal(c.landCheck.landPath,'permit_path'); assert.equal(c.landCheck.score25,14);
  assert.equal(c.landCheck.combinedScore,44); assert.ok(c.flags.includes('public_land_requires_permission'));
});

test('terminal no-match/error/unsupported scores refresh without changing source or query timestamps', () => {
  for (const status of ['no_parcel_at_point','error','unsupported_jurisdiction']) {
    const c=lead();c.landCheck={status,checkedAt:'prior',combinedScore:60,queryPosition:{lat:45,lng:-112}};
    replace(c,{lat:45,lng:-112,score:40,flags:[]});
    assert.equal(c.landCheck.status,status);assert.equal(c.landCheck.combinedScore,30);assert.equal(c.landCheck.checkedAt,'prior');
  }
});

test('checking identity and incomplete legacy parcel records are not assigned invented fit', () => {
  const c=lead(); c.landCheck={status:'checking',checkedAt:'prior'};const pending=c.landCheck;
  replace(c,{lat:45,lng:-112,score:90,flags:[]}); assert.equal(c.landCheck,pending);assert.equal(c.landCheck.fitUpdatedAt,undefined);
  c.landCheck={status:'matched',checkedAt:'legacy',combinedScore:12};
  replace(c,{lat:45,lng:-112,score:100,flags:[]});assert.equal(c.landCheck.combinedScore,12);assert.equal(c.landCheck.fitUpdatedAt,undefined);
});

test('rank order uses refreshed fit rather than the previous terrain score', () => {
  const changed=lead(), comparison=lead();comparison.id='other';comparison.landCheck.combinedScore=70;
  replace(changed,{lat:45,lng:-112,score:40,flags:[]});
  const order=[changed,comparison].sort(context.missionCandidateSort);
  assert.equal(order[0].id,'other'); assert.equal(changed.landCheck.combinedScore,55);
});

test('real card renderer shows escaped retained-location reason, with current exclusions distinct', () => {
  const c={...lead(),verdict:'reject',rejectReason:'<script>old area</script>',flags:['prior_area_rejection_retained'],agent:'fixture'};
  context.reconMission={cells:[],candidates:[c],status:'complete',name:'fixture',errors:0,rejected:0};
  context.renderMissionCockpit();
  const output=elements.get('missionReports').innerHTML;
  assert.match(output,/Rejection retained from an earlier location: &lt;script&gt;old area&lt;\/script&gt;/);
  assert.doesNotMatch(output,/<script>old area/);
  c.flags=['inside_rejected_area'];context.renderMissionCockpit();assert.doesNotMatch(elements.get('missionReports').innerHTML,/Rejection retained from an earlier location/);
  c.flags=['prior_area_rejection_retained'];c.verdict='sideline';assert.equal(context.missionReviewSummary(c),c.rejectReason);
});

const incompleteParcels = [
  ['missing',undefined], ['null',null], ['empty',[]], ['non-array',{}], ['null first',[null]],
  ['string first',['not a parcel']], ['number first',[3]], ['boolean first',[true]],
  ['array first',[[]]], ['empty object first',[{}]],
];
for (const [name,parcels] of incompleteParcels) test(`incomplete matched source is safe before refresh and retains evidence after refresh (${name})`, () => {
  const stored=lead();stored.landCheck.parcels=parcels;stored.landCheck.landPathLabel='Private purchase lead';
  stored.landCheck.fitUpdatedAt='original-fit-date';stored.flags=['public_land_requires_permission'];
  stored.verdict='reject';stored.rejectReason='Retained manual decision';stored.rejectedAt='original-review-date';
  stored.manualReview={source:'candidate',verdict:'reject',reason:stored.rejectReason,at:stored.rejectedAt};
  stored.manualReviewHistory=[{decision:{reason:'Earlier decision'}}];
  const c=JSON.parse(JSON.stringify(stored)), before=JSON.parse(JSON.stringify(c));
  const provider=c.landCheck.provider;
  assert.equal(context.currentMissionLandFit(c),null);
  assert.equal(context.landCheckLabel(c),'Parcel evidence incomplete · recheck needed');
  context.reconMission={cells:[],candidates:[c],status:'complete',name:'fixture',errors:0,rejected:0};
  context.renderMissionCockpit();
  assert.doesNotMatch(elements.get('missionReports').innerHTML,/FIT 85|Private purchase lead|No parcel match/);
  assert.match(elements.get('missionReports').innerHTML,/Parcel evidence incomplete/);
  assert.equal(elements.get('missionLand').textContent,0);
  assert.match(elements.get('missionStatus').textContent,/0 private purchase leads/);
  const comparison={id:'terrain-only',verdict:'reject',score:81};
  assert.equal([c,comparison].sort(context.missionCandidateSort)[0].id,'terrain-only');
  assert.deepEqual(c,before,'read-only display and sorting must not discard saved evidence');
  replace(c,{lat:45,lng:-112,score:40,verdict:'advance',flags:[]});
  const saved=JSON.parse(JSON.stringify(c));
  assert.deepEqual(saved.terrainReviewHistory[0].landCheck,before.landCheck);
  assert.deepEqual(saved.manualReview,before.manualReview);assert.deepEqual(saved.manualReviewHistory,before.manualReviewHistory);
  assert.equal(saved.verdict,'reject');assert.equal(saved.rejectReason,'Retained manual decision');
  assert.equal(saved.landCheck.status,'matched');assert.equal(saved.landCheck.checkedAt,before.landCheck.checkedAt);
  assert.equal(saved.landCheck.fitUpdatedAt,'original-fit-date');assert.equal(saved.landCheck.fitStatus,'incomplete_parcel_evidence');
  assert.equal(context.currentMissionLandFit(saved),null);assert.ok(saved.flags.includes('parcel_status_unknown'));
  assert.ok(!saved.flags.includes('public_land_requires_permission'));
  provider.name='later mutation';assert.equal(c.terrainReviewHistory[0].landCheck.provider.name,'Retained official parcel source');
});

test('valid parcel matches with missing or malformed acreage stay safe without invented acreage points', () => {
  for (const acres of [undefined,null,'160',{},NaN,Infinity,-1]) {
    const c=lead();c.landCheck.parcels[0].acres=acres;
    assert.match(context.landCheckLabel(c),/acreage unknown/);
    replace(c,{lat:45,lng:-112,score:80,flags:['parcel_status_unknown']});
    assert.equal(c.landCheck.landPath,'private_followup');assert.equal(c.landCheck.score25,15);
    assert.equal(c.landCheck.combinedScore,75);assert.ok(!c.flags.includes('parcel_status_unknown'));
    assert.equal(context.currentMissionLandFit(c),c.landCheck);
  }
  const valid=lead();valid.landCheck.landPathLabel='Private purchase lead';
  assert.equal(context.landCheckLabel(valid),'Private purchase lead · 160 ac');
  assert.equal(context.currentMissionLandFit(valid),valid.landCheck);
  assert.equal([lead(),{id:'unknown',score:100,verdict:'sideline'}].sort(context.missionCandidateSort)[0].id,'same');
});

test('scoring absent source records returns incomplete evidence rather than an invented no-match', () => {
  for(const [,parcels] of incompleteParcels) {
    const fit=context.scoreLandFit(lead(),{parcels});
    assert.equal(fit.landPath,'unknown');assert.equal(fit.combinedScore,null);
    assert.equal(fit.landPathLabel,'Parcel evidence incomplete');
  }
});
