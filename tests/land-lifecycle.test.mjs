import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const lead=(id,extra={})=>({id,lat:45,lng:-112,score:80,verdict:'sideline',flags:[],agent:'fixture',
  verticalM:200,clusterSpanM:400,aspect:'N',...extra});
const validLand=id=>({status:'matched',checkedAt:'prior-source-date',provider:{name:'Fixture source'},
  parcels:[{parcelId:id,ownershipClass:'private',acres:40}],landPath:'private_followup',landPathLabel:'Private parcel follow-up',combinedScore:70});
function setup(candidates,fetcher=()=>{throw Error('unexpected fetch');}) {
  const elements=new Map(),stored=new Map(),logs=[],requests=[],shapes=[],saves=[];
  stored.set('mission',JSON.stringify({id:'mission-id',name:'Fixture',status:'complete',cells:[],candidates,
    exclusions:[{id:'saved-area',reason:'Retained exclusion',bounds:{south:44,north:44.1,west:-113,east:-112.9}}],errors:0,rejected:0}));
  const layer=()=>({clearLayers(){}});
  const shape=(type,args)=>{const record={type,args};shapes.push(record);return{
    bindPopup(popup){record.popup=popup;return this;},addTo(){return this;}};};
  const context=vm.createContext({MISSION_KEY:'mission',reconMission:null,missionPaused:false,missionParcelGeometry:new Map(),
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{style:{},innerHTML:'',textContent:''});return elements.get(id);}},
    localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>{stored.set(key,value);saves.push(JSON.parse(value));},removeItem:key=>stored.delete(key)},
    L:Object.fromEntries(['polygon','circle','circleMarker','geoJSON','rectangle'].map(type=>[type,(...args)=>shape(type,args)])),
    missionLayer:layer(),missionParcelLayer:layer(),log:(message,level)=>logs.push({message,level}),
    fetchOfficialLandParcels:async(lat,lng)=>{requests.push({lat,lng});return fetcher(lat,lng);}});
  const helpers=html.slice(html.indexOf('function escapeLandText('),html.indexOf('function publicNullableNumber('));
  const checks=html.slice(html.indexOf('async function checkMissionCandidateLand('),html.indexOf('function applyMissionPreset('));
  const storage=html.slice(html.indexOf('function saveReconMission('),html.indexOf('async function launchReconMission('));
  const render=html.slice(html.indexOf('function replaceMissionCandidateEvidence('),html.indexOf('async function zoneScan('));
  vm.runInContext(helpers+checks+storage+render,context);
  return {context,elements,stored,logs,requests,shapes,saves,load:()=>context.loadReconMission(),
    saved:()=>JSON.parse(stored.get('mission')),output:()=>elements.get('missionReports').innerHTML};
}

test('actual load sorts persisted malformed purchase lead out of the first 30 before render and save',()=>{
  const malformed=lead('malformed',{lat:46.1234,score:100,landCheck:{status:'matched',parcels:[],
    landPath:'purchase_lead',landPathLabel:'Private purchase lead',combinedScore:999,checkedAt:'original'},
    manualReview:{verdict:'sideline',reason:'Retained decision'},manualReviewHistory:[{decision:{reason:'History'}}]});
  const candidates=[malformed,...Array.from({length:30},(_,i)=>lead(`valid-${i}`,{landCheck:validLand(`parcel-${i}`)}))];
  const s=setup(candidates);s.load();
  assert.equal(s.context.reconMission.candidates[0].id,'valid-0');
  assert.equal(s.context.reconMission.candidates.at(-1).id,'malformed');
  assert.equal(s.saved().candidates[0].id,'valid-0');assert.equal(s.saved().candidates.length,31);
  assert.match(s.output(),/#1 45\.0000, -112\.0000/);assert.doesNotMatch(s.output(),/46\.1234|FIT 999/);
  assert.deepEqual(s.saved().candidates.at(-1),malformed);
  assert.equal(s.saved().exclusions[0].id,'saved-area');
  assert.equal(s.saves.length,1);assert.equal(s.saves[0].candidates[0].id,'valid-0');
  s.context.drawMissionCandidates();
  assert.equal(s.shapes.filter(p=>p.type==='circleMarker').length,30);
  assert.ok(!s.shapes.some(p=>p.type==='circleMarker'&&p.args[0][0]===46.1234));
});

test('actual bulk check retries incomplete matches and counts only repaired parcel evidence',async()=>{
  const kept=lead('kept',{lat:45.01,landCheck:validLand('kept')});
  const broken=lead('repair',{lat:45.02,verdict:'reject',rejectReason:'Manual exclusion',
    manualReview:{source:'candidate',verdict:'reject',reason:'Manual exclusion'},
    manualReviewHistory:[{decision:{reason:'Manual exclusion'}}],landCheck:{status:'matched',parcels:[],checkedAt:'old',combinedScore:999}});
  const stillIncomplete=lead('still-incomplete',{lat:45.03,landCheck:{status:'matched',parcels:[null],checkedAt:'old'}});
  const original=clone(broken);
  const s=setup([broken,kept,stillIncomplete],lat=>lat===45.02
    ? {supported:true,status:'matched',checkedAt:'new',parcels:[{parcelId:'repaired',ownershipClass:'private',acres:40,geometry:{type:'Point',coordinates:[-112,lat]}}]}
    : {supported:true,status:'matched',checkedAt:'new-incomplete',parcels:[null],provider:{name:'Incomplete response'}});
  s.load();await s.context.checkMissionLand();
  assert.deepEqual(s.requests.map(r=>r.lat).sort(),[45.02,45.03]);
  const repaired=s.saved().candidates.find(c=>c.id==='repair'),incomplete=s.saved().candidates.find(c=>c.id==='still-incomplete');
  assert.equal(repaired.landCheck.parcels[0].parcelId,'repaired');
  assert.deepEqual(repaired.landCheckHistory[0],original.landCheck);
  assert.deepEqual(repaired.manualReview,original.manualReview);assert.deepEqual(repaired.manualReviewHistory,original.manualReviewHistory);
  assert.equal(repaired.verdict,'reject');assert.equal(repaired.rejectReason,'Manual exclusion');
  assert.ok(incomplete.flags.includes('parcel_status_unknown'));assert.equal(incomplete.landCheck.fitStatus,'incomplete_parcel_evidence');
  assert.equal(s.context.missionParcelGeometry.has('still-incomplete'),false);
  assert.equal(s.elements.get('missionLand').textContent,2);
  assert.match(s.logs.at(-1).message,/2 candidate centers matched to mapped parcels/);
  assert.ok(!s.logs.some(entry=>entry.message.includes('All ranked leads')));
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
  assert.equal(s.elements.get('missionLandBtn').textContent,'Check Land');
});

test('bulk check with only incomplete matches retries them and reports zero rather than all checked',async()=>{
  const s=setup([lead('incomplete',{landCheck:{status:'matched',parcels:null}})],()=>({supported:true,status:'matched',parcels:[],checkedAt:'retry'}));
  s.load();await s.context.checkMissionLand();
  assert.equal(s.requests.length,1);assert.match(s.logs.at(-1).message,/0 candidate centers matched to mapped parcels/);
  assert.equal(s.logs.at(-1).level,'warn');assert.equal(s.elements.get('missionLand').textContent,0);
});

test('fresh malformed parcel responses preserve evidence without publishing geometry or a match',async()=>{
  for(const parcels of [undefined,null,{},[],[null],['bad'],[{}],[[]]]) {
    const payload={supported:true,status:'matched',checkedAt:'response-date',provider:{name:'Source'},parcels};
    const s=setup([lead('incomplete',{flags:['public_land_requires_permission']})],()=>payload);
    s.load();s.context.missionParcelGeometry.set('incomplete',[{type:'Point',coordinates:[-112,45]}]);
    await s.context.checkMissionCandidateLand('incomplete');
    const candidate=s.saved().candidates[0];
    assert.equal(candidate.landCheck.status,'matched');assert.equal(candidate.landCheck.fitStatus,'incomplete_parcel_evidence');
    assert.equal(candidate.landCheck.checkedAt,'response-date');assert.equal(candidate.landCheck.provider.name,'Source');
    assert.deepEqual(candidate.landCheck.parcels,clone(payload).parcels);
    assert.ok(candidate.flags.includes('parcel_status_unknown'));assert.ok(!candidate.flags.includes('public_land_requires_permission'));
    assert.equal(s.context.missionParcelGeometry.has('incomplete'),false);
    assert.equal(s.elements.get('missionLand').textContent,0);assert.match(s.output(),/Parcel evidence incomplete/);
    assert.doesNotMatch(s.output(),/No mapped parcel|FIT /);
  }
});

test('actual parcel popups handle malformed acreage and suppress geometry without a usable record',()=>{
  for(const acres of ['160',{},null,undefined,-1,NaN,Infinity,160]) {
    const c=lead('parcel',{landCheck:validLand('parcel')});c.landCheck.parcels[0].acres=acres;
    const s=setup([c]);s.load();s.context.missionParcelGeometry.set('parcel',[{type:'Point',coordinates:[-112,45]}]);
    s.context.drawMissionCandidates();
    const popup=s.shapes.find(p=>p.type==='geoJSON').popup;
    assert.match(popup,acres===160?/160\.0 acres/:/Acreage unavailable/);
  }
  const s=setup([lead('invalid',{landCheck:{status:'matched',parcels:[null]}})]);s.load();
  s.context.missionParcelGeometry.set('invalid',[{type:'Point',coordinates:[-112,45]}]);
  s.context.drawMissionCandidates();assert.ok(!s.shapes.some(p=>p.type==='geoJSON'));
});

test('load recovers interrupted land requests once without fetching or changing source/review history',()=>{
  const pending={status:'checking',checkedAt:'exact-pending-time',queryPosition:{lat:45,lng:-112},
    combinedScore:999,landPath:'purchase_lead',parcels:[{parcelId:'stale'}],customRequest:'preserve'};
  const original=lead('pending',{landCheck:pending,flags:['public_land_requires_permission'],
    landCheckHistory:[validLand('prior')],manualReview:{source:'candidate',verdict:'sideline',reason:'Keep for research'},
    manualReviewHistory:[{decision:{reason:'Keep for research'}}],terrainReviewHistory:[{score:50}]});
  const complete=lead('complete',{lat:45.01,landCheck:validLand('complete')});
  const s=setup([original,complete]);s.context.missionParcelGeometry.set('pending',[{type:'Point',coordinates:[-112,45]}]);
  s.load();
  const restored=s.saved().candidates.find(c=>c.id==='pending');
  assert.equal(restored.landCheck.status,'interrupted');
  assert.equal(restored.landCheck.checkedAt,pending.checkedAt);assert.deepEqual(restored.landCheck.queryPosition,pending.queryPosition);
  assert.deepEqual(restored.landCheck.interruptedRequest,pending);
  assert.deepEqual(restored.landCheckHistory,original.landCheckHistory);
  assert.deepEqual(restored.manualReview,original.manualReview);assert.deepEqual(restored.manualReviewHistory,original.manualReviewHistory);
  assert.deepEqual(restored.terrainReviewHistory,original.terrainReviewHistory);
  assert.deepEqual(s.saved().candidates.find(c=>c.id==='complete'),complete);
  assert.ok(restored.flags.includes('parcel_status_unknown'));assert.ok(!restored.flags.includes('public_land_requires_permission'));
  assert.equal(s.requests.length,0);assert.equal(s.context.missionParcelGeometry.has('pending'),false);
  assert.equal(s.saved().candidates[0].id,'complete');assert.equal(s.context.currentMissionLandFit(restored),null);
  assert.match(s.output(),/Land check interrupted · retry needed/);assert.doesNotMatch(s.output(),/Checking official parcels|FIT 999|Land check error|No mapped parcel/);
  const once=s.stored.get('mission');s.load();assert.equal(s.stored.get('mission'),once);
  const current=s.context.reconMission.candidates.find(c=>c.id==='pending');
  current.landCheck.queryPosition.lat=90;assert.equal(current.landCheck.interruptedRequest.queryPosition.lat,45);
});

test('active checking markers never contribute stale FIT or purchase rank before recovery',()=>{
  const c=lead('pending',{landCheck:{status:'checking',combinedScore:999,landPath:'purchase_lead',parcels:[{parcelId:'stale'}]}});
  const s=setup([c]);s.context.reconMission=clone(s.saved());
  s.context.renderMissionCockpit();
  assert.equal(s.context.currentMissionLandFit(c),null);assert.doesNotMatch(s.output(),/FIT 999/);
  assert.match(s.elements.get('missionStatus').textContent,/0 private purchase leads/);
  const stronger=lead('stronger',{score:90});
  assert.equal([c,stronger].sort(s.context.missionCandidateSort)[0].id,'stronger');
});

for(const oldFails of [false,true]) test(`explicit bulk retry after reload ignores late old ${oldFails?'failure':'success'} and retains history`,async()=>{
  const deferred=[];
  const c=lead('retry',{verdict:'reject',rejectReason:'Manual rejection',landCheck:validLand('old-source'),
    manualReview:{source:'candidate',verdict:'reject',reason:'Manual rejection'},manualReviewHistory:[{decision:{reason:'Manual rejection'}}]});
  const s=setup([c],()=>new Promise((resolve,reject)=>deferred.push({resolve,reject})));
  s.load();const old=s.context.checkMissionCandidateLand('retry',{silent:true});
  s.context.saveReconMission();const originalPending=clone(s.saved().candidates[0].landCheck);
  s.load();assert.equal(s.requests.length,1);
  assert.equal(s.saved().candidates[0].landCheck.status,'interrupted');
  const retry=s.context.checkMissionLand(),current=s.context.reconMission.candidates[0],retryMarker=current.landCheck;
  assert.equal(s.requests.length,2);assert.equal(retryMarker.status,'checking');
  const persistedBeforeLate=s.stored.get('mission'),savesBeforeLate=s.saves.length;
  if(oldFails)deferred[0].reject(new Error('late network failure'));
  else deferred[0].resolve({supported:true,status:'matched',checkedAt:'late',parcels:[{parcelId:'stale-response'}]});
  assert.equal(await old,null);assert.equal(current.landCheck,retryMarker);
  assert.equal(s.stored.get('mission'),persistedBeforeLate);assert.equal(s.saves.length,savesBeforeLate);
  deferred[1].resolve({supported:true,status:'matched',checkedAt:'new-source-time',parcels:[{parcelId:'fresh',ownershipClass:'private',acres:40}]});
  await retry;
  const saved=s.saved().candidates[0];
  assert.equal(saved.landCheck.parcels[0].parcelId,'fresh');assert.equal(saved.landCheck.checkedAt,'new-source-time');
  assert.equal(saved.landCheckHistory[0].parcels[0].parcelId,'old-source');
  assert.equal(saved.landCheckHistory[1].status,'interrupted');assert.deepEqual(saved.landCheckHistory[1].interruptedRequest,originalPending);
  assert.deepEqual(saved.manualReview,c.manualReview);assert.deepEqual(saved.manualReviewHistory,c.manualReviewHistory);
  assert.equal(saved.verdict,'reject');assert.equal(saved.rejectReason,'Manual rejection');
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
  assert.match(s.logs.at(-1).message,/1 candidate centers matched to mapped parcels/);
});
