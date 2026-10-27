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
  const context=vm.createContext({MISSION_KEY:'mission',reconMission:null,missionActiveRaw:null,missionExportedArchives:null,missionExportedActive:null,missionStopRequested:false,missionPaused:false,missionRunning:false,missionParcelGeometry:new Map(),missionLandRequests:new WeakMap(),missionLandBatch:null,
    Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:()=>{},confirm:()=>false,
    document:{createElement:()=>({click(){}}),getElementById:id=>{if(!elements.has(id))elements.set(id,{style:{},innerHTML:'',textContent:''});return elements.get(id);}},
    localStorage:{get length(){return stored.size;},key:i=>[...stored.keys()][i]??null,getItem:key=>stored.get(key),setItem:(key,value)=>{stored.set(key,value);saves.push(JSON.parse(value));},removeItem:key=>stored.delete(key)},
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

function installWorker(s) {
  const zone={maxVert:500,width:400,pointCount:6,maxElev:1000,minElev:500,centroidLat:45,centroidLng:-112,
    aspectDir:'N',points:[{lat:45,lng:-112,elevation:1000},{lat:45.001,lng:-112,elevation:750},{lat:45.002,lng:-112,elevation:500}]};
  Object.assign(s.context,{missionStopRequested:false,currentRegion:'usa',convexHull:points=>points,
    RunEngine:{setZoneSensitivity(){},scanZones:async()=>zone.points,clusterZones:()=>[zone],fetchRoads:async()=>[]}});
  s.context.reconMission.minElevation=0;
  s.context.reconMission.cells=[{id:'cell',status:'pending',attempts:0,bounds:{south:44.9,north:45.1,west:-112.1,east:-111.9}}];
  vm.runInContext(html.slice(html.indexOf('function missionHash('),html.indexOf('function saveReconMission('))
    +html.slice(html.indexOf('async function runMissionWorker('),html.indexOf('function toggleMissionPause('))
    +html.slice(html.indexOf('function findMissionExclusion('),html.indexOf('function rejectCurrentMapArea(')),s.context);
}
const response=id=>({supported:true,status:'matched',checkedAt:'new',parcels:[{parcelId:id,ownershipClass:'private',acres:40}]});

for(const workerFirst of [true,false]) test(workerFirst?'bulk check joins the actual worker pending request':'bulk request remains the sole lookup when the worker retains a stronger existing lead',async()=>{
  let finish,started;
  const begun=new Promise(resolve=>started=resolve);
  const s=setup(workerFirst?[]:[lead('existing')],()=>{started();return new Promise(resolve=>finish=resolve);});
  s.load();installWorker(s);
  const first=workerFirst?s.context.runMissionWorker('worker'):s.context.checkMissionLand();
  await begun;
  const second=workerFirst?s.context.checkMissionLand():s.context.runMissionWorker('worker');
  if(!workerFirst)await second;
  assert.equal(s.requests.length,1);
  finish(response('shared'));await Promise.all([first,second]);
  assert.equal(s.requests.length,1);assert.equal(s.saved().candidates[0].landCheck.parcels[0].parcelId,'shared');
  assert.equal(s.saved().candidates[0].landCheckHistory,undefined);
  assert.ok(!s.stored.get('mission').includes('promise'));
  assert.equal(s.context.missionLandRequests.get(s.context.reconMission.candidates[0]),undefined);
});

test('a visible caller joins a silent check and renders the shared result without duplicate history or saves',async()=>{
  let finish;
  const original=lead('join',{landCheck:validLand('old'),manualReview:{reason:'Keep'},manualReviewHistory:[{decision:{reason:'Keep'}}]});
  const s=setup([original],()=>new Promise(resolve=>finish=resolve));s.load();
  const first=s.context.checkMissionCandidateLand('join',{silent:true});
  const joined=s.context.checkMissionCandidateLand('join');
  assert.equal(s.requests.length,1);finish(response('visible-result'));
  assert.equal(await first,await joined);assert.match(s.output(),/visible-result/);
  assert.ok(s.shapes.length);assert.equal(s.saves.length,2);
  const saved=s.saved().candidates[0];assert.equal(saved.landCheckHistory.length,1);
  assert.deepEqual(saved.manualReview,original.manualReview);assert.deepEqual(saved.manualReviewHistory,original.manualReviewHistory);
});

test('network failure releases the flight for retry and completed checks can be explicitly rechecked',async()=>{
  const deferred=[];const s=setup([lead('retry')],()=>new Promise((resolve,reject)=>deferred.push({resolve,reject})));s.load();
  const first=s.context.checkMissionCandidateLand('retry',{silent:true}),joined=s.context.checkMissionCandidateLand('retry',{silent:true});
  deferred[0].reject(new Error('temporary failure'));await Promise.all([first,joined]);
  assert.equal(s.requests.length,1);assert.equal(s.saved().candidates[0].landCheck.status,'error');
  const second=s.context.checkMissionCandidateLand('retry',{silent:true});assert.equal(s.requests.length,2);
  deferred[1].resolve(response('repaired'));await second;
  const third=s.context.checkMissionCandidateLand('retry',{silent:true});assert.equal(s.requests.length,3);
  deferred[2].resolve(response('rechecked'));await third;
  assert.deepEqual(s.saved().candidates[0].landCheckHistory.map(c=>c.status),['error','matched']);
});

test('moved coordinates start fresh and an old completion cannot clear the newer joinable flight',async()=>{
  const deferred=[];const s=setup([lead('move')],()=>new Promise(resolve=>deferred.push(resolve)));s.load();
  const old=s.context.checkMissionCandidateLand('move',{silent:true});
  const c=s.context.reconMission.candidates[0];c.lat=45.002;
  const fresh=s.context.checkMissionCandidateLand('move',{silent:true});
  assert.equal(s.requests.length,2);deferred[0](response('old'));assert.equal(await old,null);
  const joined=s.context.checkMissionCandidateLand('move',{silent:true});assert.equal(s.requests.length,2);
  deferred[1](response('fresh'));assert.equal(await fresh,await joined);
  assert.equal(s.saved().candidates[0].landCheck.queryPosition.lat,45.002);
});


function installClear(s) {
  Object.assign(s.context,{missionRunning:false,missionStopRequested:false});
  vm.runInContext(html.slice(html.indexOf('function clearReconMission('),html.indexOf('function findMissionExclusion(')),s.context);
}
for(const fails of [false,true]) test(`bulk check stops after Clear despite late ${fails?'errors':'matches'}`,async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('clear-'+i,{lat:45+i/100})),()=>new Promise((resolve,reject)=>deferred.push({resolve,reject})));
  s.load();installClear(s);const outcome=s.context.checkMissionLand().then(()=>null,e=>e);
  assert.equal(s.requests.length,3);s.context.clearReconMission();
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
  for(const d of deferred)fails?d.reject(new Error('late')):d.resolve(response('old'));
  assert.equal(await outcome,null);assert.equal(s.requests.length,3);assert.equal(s.context.reconMission,null);
  assert.equal(s.stored.has('mission'),false);assert.ok(!s.logs.some(l=>l.message.includes('screening complete')));
});

test('old bulk completion cannot query reused IDs or reset controls owned by a replacement mission',async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('same-'+i,{lat:45+i/100})),()=>new Promise(resolve=>deferred.push(resolve)));
  s.load();const old=s.context.checkMissionLand().then(()=>null,e=>e);assert.equal(s.requests.length,3);
  const replacement=s.saved();replacement.id='replacement';replacement.candidates=Array.from({length:4},(_,i)=>lead('same-'+i,{lat:46+i/100}));
  s.stored.set('mission',JSON.stringify(replacement));s.load();
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
  const fresh=s.context.checkMissionLand();assert.equal(s.requests.length,6);
  deferred.slice(0,3).forEach(resolve=>resolve(response('old')));assert.equal(await old,null);
  assert.equal(s.requests.length,6);assert.equal(s.elements.get('missionLandBtn').disabled,true);
  assert.ok(!s.logs.some(l=>l.message.includes('screening complete')));
  deferred.slice(3,6).forEach(resolve=>resolve(response('new')));
  // Let the first batch settle and the queued fourth request begin.
  for(let i=0;i<12&&s.requests.length<7;i++)await Promise.resolve();
  assert.equal(s.requests.length,7);assert.equal(s.requests[6].lat,46.03);
  deferred[6](response('fourth'));await fresh;
  assert.equal(s.saved().id,'replacement');assert.equal(s.elements.get('missionLandBtn').disabled,false);
  assert.equal(s.logs.filter(l=>l.message.includes('screening complete')).length,1);
  assert.ok(s.saved().candidates.every(c=>!JSON.stringify(c).includes('"old"')));
});

test('Clear during an active mission cancels remaining bulk batches while retaining completed evidence',async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('stop-'+i,{lat:45+i/100})),()=>new Promise(resolve=>deferred.push(resolve)));
  s.load();installClear(s);s.context.missionRunning=true;
  const bulk=s.context.checkMissionLand();const mission=s.context.reconMission;s.context.clearReconMission();
  assert.equal(s.context.reconMission,mission);assert.equal(mission.status,'stopped');
  deferred.forEach(resolve=>resolve(response('completed-before-stop')));await bulk;
  assert.equal(s.requests.length,3);assert.equal(s.saved().candidates.filter(c=>c.landCheck?.status==='matched').length,3);
  assert.equal(s.saved().candidates.find(c=>c.id==='stop-3').landCheck,undefined);
  assert.ok(!s.logs.some(l=>l.message.includes('screening complete')));assert.equal(s.elements.get('missionLandBtn').disabled,true);
});

test('late silent results repaint the retained stopped mission after workers have exited',async()=>{
  let finish;const c=lead('late',{landCheck:{status:'error',checkedAt:'prior-check',error:'retry',parcels:[]},landCheckHistory:[validLand('old')],manualReview:{reason:'Retain'},manualReviewHistory:[{decision:{reason:'Retain'}}]});
  const s=setup([c],()=>new Promise(resolve=>finish=resolve));s.load();installClear(s);s.context.missionRunning=true;
  const pending=s.context.checkMissionLand();
  s.context.clearReconMission();s.context.missionRunning=false;s.context.renderMissionCockpit();
  assert.match(s.output(),/Checking official parcels/);
  finish({...response('late-current'),parcels:[{parcelId:'late-current',ownershipClass:'private',acres:40,geometry:{type:'Point',coordinates:[-112,45]}}]});
  await pending;
  assert.match(s.output(),/late-current/);assert.doesNotMatch(s.output(),/Checking official parcels/);
  assert.ok(s.shapes.some(shape=>shape.type==='geoJSON'));
  assert.match(s.elements.get('missionStatus').textContent,/Stopped/);
  assert.deepEqual(s.saved().candidates[0].manualReview,c.manualReview);
  assert.deepEqual(s.saved().candidates[0].manualReviewHistory,c.manualReviewHistory);
  assert.deepEqual(s.saved().candidates[0].landCheckHistory[0],c.landCheckHistory[0]);
  assert.deepEqual(s.saved().candidates[0].landCheckHistory[1],c.landCheck);
});

test('Clear keeps Check Land disabled and rejects bulk restart until workers stop',async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('stopping-'+i,{lat:45+i/100})),()=>new Promise(resolve=>deferred.push(resolve)));
  s.load();installClear(s);s.context.missionRunning=true;
  const first=s.context.checkMissionLand();s.context.clearReconMission();
  assert.equal(s.elements.get('missionLandBtn').disabled,true);
  const restart=s.context.checkMissionLand();assert.equal(s.context.missionLandBatch,null);
  assert.equal(s.requests.length,3);
  deferred.forEach(resolve=>resolve(response('current')));await Promise.all([first,restart]);
  assert.equal(s.requests.length,3);assert.equal(s.elements.get('missionLandBtn').disabled,true);
  assert.match(s.elements.get('missionStatus').textContent,/Stopping/);
});

function installLaunch(s) {
  Object.assign(s.context,{missionRunning:false,missionStopRequested:false,currentRegion:'usa',MISSION_PRESETS:{},map:{getCenter:()=>({lat:46,lng:-112})}});
  s.elements.set('missionPreset',{value:'current'});s.elements.set('missionRadius',{value:6});s.elements.set('baseElevSlider',{value:100});
  vm.runInContext(html.slice(html.indexOf('function missionCellGrid('),html.indexOf('function missionHash('))
    +html.slice(html.indexOf('async function launchReconMission('),html.indexOf('async function runMissionWorker(')),s.context);
  const workers=[];s.context.runMissionWorker=()=>new Promise(resolve=>workers.push(resolve));
  return ()=>{s.context.reconMission.cells.forEach(cell=>cell.status='complete');workers.forEach(resolve=>resolve());};
}

test('actual launch replacement cancels old bulk ownership and isolates reused IDs and late results',async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('replace-'+i,{lat:45+i/100})),()=>new Promise(resolve=>deferred.push(resolve)));
  s.load();const oldMission=s.context.reconMission,exclusions=clone(oldMission.exclusions);
  const oldBulk=s.context.checkMissionLand();assert.equal(s.requests.length,3);
  const finishWorkers=installLaunch(s),launch=s.context.launchReconMission();
  assert.notEqual(s.context.reconMission,oldMission);assert.equal(s.context.missionLandBatch,null);
  assert.deepEqual(clone(s.context.reconMission.exclusions),exclusions);
  const replacement=s.context.reconMission;replacement.candidates=[lead('replace-0',{lat:46})];
  const freshBulk=s.context.checkMissionLand(),newOperation=s.context.missionLandBatch;
  assert.equal(s.requests.length,4);assert.equal(s.requests[3].lat,46);
  const saves=s.saves.length,output=s.output();deferred.slice(0,3).forEach(resolve=>resolve(response('obsolete')));await oldBulk;
  assert.equal(s.saves.length,saves);assert.equal(s.output(),output);assert.equal(s.context.missionLandBatch,newOperation);
  assert.equal(s.elements.get('missionLandBtn').disabled,true);assert.equal(s.requests.length,4);
  deferred[3](response('replacement-result'));await freshBulk;finishWorkers();await launch;
  assert.equal(s.saved().id,replacement.id);assert.equal(s.saved().candidates[0].landCheck.parcels[0].parcelId,'replacement-result');
  assert.ok(!JSON.stringify(s.saved()).includes('obsolete'));assert.equal(s.context.missionRunning,false);
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
});

test('actual launch exit releases stopping controls and labels retained results as stopped',async()=>{
  const s=setup([]);s.load();installClear(s);const finishWorkers=installLaunch(s);
  const launch=s.context.launchReconMission();s.context.clearReconMission();
  assert.equal(s.elements.get('missionLandBtn').disabled,true);
  finishWorkers();await launch;
  assert.equal(s.context.missionRunning,false);assert.equal(s.context.reconMission.status,'stopped');
  assert.equal(s.elements.get('missionLandBtn').disabled,false);
  assert.match(s.elements.get('missionStatus').textContent,/Stopped/);
});


test('Resume Mission retains a stopped mission and its candidates, decisions, evidence and original search settings',async()=>{
  const original=lead('retained',{verdict:'reject',rejectReason:'Keep exclusion',landCheck:validLand('retained-source'),
    landCheckHistory:[validLand('older-source')],manualReview:{source:'candidate',verdict:'reject',reason:'Keep exclusion'},
    manualReviewHistory:[{decision:{reason:'Keep exclusion'}}],terrainReviewHistory:[{score:40}]});
  const s=setup([original]);s.load();const mission=s.context.reconMission;
  Object.assign(mission,{status:'stopped',cellKm:12,radiusKm:18,center:{lat:45,lng:-112},minElevation:750,
    cells:[{id:'done',status:'complete',attempts:1},{id:'todo',status:'pending',attempts:0}],errors:2,rejected:3});
  const before=clone(mission),finish=installLaunch(s),launch=s.context.launchReconMission();
  assert.equal(s.context.reconMission,mission);assert.equal(mission.status,'running');
  for(const key of ['id','center','radiusKm','cellKm','minElevation','candidates','exclusions','errors','rejected','cells'])
    assert.deepEqual(clone(mission[key]),before[key],key);
  finish();await launch;
  assert.deepEqual(s.saved().candidates,before.candidates);assert.equal(s.saved().id,before.id);
  assert.equal(s.saved().status,'complete');assert.deepEqual(s.saved().exclusions,before.exclusions);
});

test('stopped mission survives reload and cannot be silently replaced by a different region',async()=>{
  const c=lead('retained',{manualReviewHistory:[{decision:{reason:'Saved decision'}}],landCheck:validLand('saved-source')});
  const s=setup([c]);s.load();Object.assign(s.context.reconMission,{status:'stopped',cellKm:12,minElevation:700});
  s.context.saveReconMission();s.load();const mission=s.context.reconMission,before=s.stored.get('mission'),saves=s.saves.length;
  installLaunch(s);s.context.currentRegion='japan';let workers=0;s.context.runMissionWorker=async()=>{workers++;};
  await s.context.launchReconMission();
  assert.equal(s.context.reconMission,mission);assert.equal(mission.status,'stopped');assert.equal(workers,0);
  assert.equal(s.saves.length,saves);assert.equal(s.stored.get('mission'),before);
  assert.match(s.logs.at(-1).message,/saved mission region/i);
});

test('resuming a stopped mission preserves the current bulk request owner and joins its pending land check',async()=>{
  let finishLand;const s=setup([lead('same',{landCheckHistory:[validLand('prior')]})],()=>new Promise(resolve=>finishLand=resolve));
  s.load();Object.assign(s.context.reconMission,{status:'stopped',cellKm:12});
  const oldMission=s.context.reconMission,bulk=s.context.checkMissionLand(),operation=s.context.missionLandBatch;
  const finishWorkers=installLaunch(s),launch=s.context.launchReconMission();
  assert.equal(s.context.reconMission,oldMission);assert.equal(s.context.missionLandBatch,operation);
  const joined=s.context.checkMissionCandidateLand('same',{silent:true});assert.equal(s.requests.length,1);
  finishLand(response('same-source'));await Promise.all([bulk,joined]);finishWorkers();await launch;
  assert.equal(s.saved().candidates[0].landCheck.parcels[0].parcelId,'same-source');
  assert.equal(s.saved().candidates[0].landCheckHistory.length,1);assert.equal(s.requests.length,1);
  assert.equal(s.context.missionLandBatch,null);assert.equal(s.elements.get('missionLandBtn').disabled,false);
});

test('resumed actual workers scan only unfinished cells without resetting completed coverage or retained history',async()=>{
  const c=lead('retained',{lat:47,manualReviewHistory:[{decision:{reason:'Keep'}}],landCheck:validLand('retained-source')});
  const s=setup([c],async()=>response('new-source'));s.load();installLaunch(s);installWorker(s);
  const scanned=[];s.context.RunEngine.scanZones=async bounds=>{scanned.push(bounds.tag);return [];};
  s.context.RunEngine.clusterZones=()=>[];
  const cells=[{id:'done',status:'complete',attempts:1},{id:'rejected',status:'rejected',attempts:1},
    {id:'exhausted',status:'error',attempts:2},{id:'pending',status:'pending',attempts:0,bounds:{tag:'pending'}},
    {id:'retry',status:'error',attempts:1,bounds:{tag:'retry'}}];
  Object.assign(s.context.reconMission,{status:'stopped',cellKm:12,cells});const mission=s.context.reconMission;
  await s.context.launchReconMission();
  assert.equal(s.context.reconMission,mission);assert.deepEqual(scanned.sort(),['pending','retry']);
  assert.equal(cells[0].attempts,1);assert.equal(cells[1].attempts,1);assert.equal(cells[2].attempts,2);
  assert.deepEqual(s.saved().candidates,[c]);assert.equal(s.saved().status,'complete');
});


for(const persistedStatus of ['running','paused']) test(`reload ${persistedStatus} cannot discard saved evidence on a different-region launch`,async()=>{
  const c=lead('saved',{landCheck:validLand('saved-source'),manualReviewHistory:[{decision:{reason:'Keep'}}]});
  const s=setup([c]);s.load();Object.assign(s.context.reconMission,{status:persistedStatus,cellKm:12,minElevation:700});
  s.context.saveReconMission();s.load();assert.equal(s.context.reconMission.status,'paused');
  const mission=s.context.reconMission,before=s.stored.get('mission'),saves=s.saves.length;
  installLaunch(s);s.context.currentRegion='japan';let workers=0;s.context.runMissionWorker=async()=>{workers++;};
  await s.context.launchReconMission();
  assert.equal(s.context.reconMission,mission);assert.equal(workers,0);assert.equal(mission.status,'paused');
  assert.equal(s.stored.get('mission'),before);assert.equal(s.saves.length,saves);
  assert.match(s.elements.get('missionStatus').textContent,/saved mission region.*USA/);
});

test('reload labels stopped and paused saved missions as resumable',()=>{
  for(const status of ['stopped','paused']){
    const s=setup([lead('saved')]);s.load();Object.assign(s.context.reconMission,{status,cellKm:12});
    s.context.saveReconMission();s.context.document.getElementById('missionLaunchBtn').textContent='Launch Recon Mission';s.load();
    assert.equal(s.elements.get('missionLaunchBtn').textContent,'Resume Mission');
  }
});

const historyKey='mission:history:';
function archived(s){return [...s.stored].filter(([key])=>key.startsWith(historyKey)).map(([key,raw])=>({key,...JSON.parse(raw)}));}

test('idle Clear archives the complete mission snapshot and retains it after reload and later mutation',()=>{
  const c=lead('kept',{landCheck:validLand('source'),landCheckHistory:[validLand('older')],manualReviewHistory:[{decision:{verdict:'reject',reason:'Keep history'}}],terrainReviewHistory:[{score:40}]});
  const s=setup([c]);s.load();installClear(s);const old=s.context.reconMission,before=clone(old);
  s.context.clearReconMission();assert.equal(s.context.reconMission,null);assert.equal(s.stored.has('mission'),false);
  assert.equal(archived(s).length,1);assert.deepEqual(archived(s)[0].mission,before);assert.equal(archived(s)[0].reason,'clear');
  old.candidates[0].manualReviewHistory[0].decision.reason='later mutation';s.load();
  assert.deepEqual(archived(s)[0].mission,before);assert.deepEqual(clone(s.context.missionHistoryExport().archived[0].mission),before);
});

test('completed launch archives all evidence before replacement without rewriting older snapshots',async()=>{
  const s=setup([lead('first',{manualReview:{verdict:'approve'},manualReviewHistory:[{decision:{verdict:'approve'}}]})]);s.load();
  const old=clone(s.context.reconMission),finish=installLaunch(s),launch=s.context.launchReconMission();
  assert.equal(archived(s).length,1);assert.deepEqual(archived(s)[0].mission,old);assert.equal(archived(s)[0].reason,'completed_replacement');
  const key=archived(s)[0].key,bytes=s.stored.get(key);finish();await launch;
  s.context.reconMission.candidates.push(lead('second',{manualReviewHistory:[{decision:{verdict:'reject'}}]}));installClear(s);s.context.clearReconMission();
  assert.equal(archived(s).length,2);assert.equal(s.stored.get(key),bytes);assert.equal(s.context.missionHistoryExport().archived.length,2);
});

for(const action of ['clear','launch'])test(`archive quota failure blocks ${action} before mission or request ownership changes`,async()=>{
  const s=setup([lead('preserved')]);s.load();installClear(s);installLaunch(s);const old=s.context.reconMission,before=s.stored.get('mission');
  const owner={mission:old};s.context.missionLandBatch=owner;let workers=0;s.context.runMissionWorker=async()=>workers++;
  const set=s.context.localStorage.setItem;s.context.localStorage.setItem=(key,value)=>{if(key.startsWith(historyKey))throw Error('quota');set(key,value);};
  if(action==='clear')s.context.clearReconMission();else await s.context.launchReconMission();
  assert.equal(s.context.reconMission,old);assert.equal(s.stored.get('mission'),before);assert.equal(s.context.missionLandBatch,owner);assert.equal(workers,0);assert.equal(archived(s).length,0);
  assert.match(s.elements.get('missionStatus').textContent,/history.*retained/i);
});

test('failed active-key removal retains mission and retry reuses identical snapshot',()=>{
  const s=setup([lead('preserved')]);s.load();installClear(s);const old=s.context.reconMission,before=s.stored.get('mission'),remove=s.context.localStorage.removeItem;
  s.context.localStorage.removeItem=()=>{throw Error('denied');};s.context.clearReconMission();
  assert.equal(s.context.reconMission,old);assert.equal(s.stored.get('mission'),before);assert.equal(archived(s).length,1);
  s.context.localStorage.removeItem=remove;s.context.clearReconMission();assert.equal(s.context.reconMission,null);assert.equal(archived(s).length,1);
});

test('history export preserves malformed archive bytes and includes a detached active snapshot',()=>{
  const s=setup([lead('active',{manualReviewHistory:[{decision:{reason:'Keep'}}]})]);s.load();s.stored.set(historyKey+'damaged','{broken');
  const data=clone(s.context.missionHistoryExport());assert.deepEqual(data.unreadable,[{key:historyKey+'damaged',raw:'{broken'}]);assert.deepEqual(data.active,s.saved());
  s.context.reconMission.candidates[0].id='changed';assert.equal(data.active.candidates[0].id,'active');assert.equal(s.stored.get(historyKey+'damaged'),'{broken');
});

test('late parcel result cannot mutate an archived Clear snapshot or launch queued work',async()=>{
  const deferred=[];const s=setup(Array.from({length:4},(_,i)=>lead('archived-'+i)),()=>new Promise(resolve=>deferred.push(resolve)));
  s.load();installClear(s);const pending=s.context.checkMissionLand();s.context.clearReconMission();const record=archived(s)[0];assert.ok(record);const bytes=s.stored.get(record.key);
  deferred.forEach(resolve=>resolve(response('late')));await pending;
  assert.equal(s.requests.length,3);assert.equal(s.stored.get(record.key),bytes);assert.equal(s.context.reconMission,null);assert.equal(s.stored.has('mission'),false);
});

test('successful replacement archive followed by ACTIVE quota failure retains both bytes and releases pre-worker controls',async()=>{
  const c=lead('old',{manualReviewHistory:[{decision:{reason:'Immutable review'}}]});
  const s=setup([c]);s.load();installLaunch(s);const before=s.stored.get('mission'),old=clone(s.context.reconMission);
  let workers=0;s.context.runMissionWorker=async()=>workers++;
  const set=s.context.localStorage.setItem;s.context.localStorage.setItem=(key,value)=>{if(key==='mission')throw Error('quota after archive');set(key,value);};
  await s.context.launchReconMission();
  assert.equal(workers,0);assert.equal(s.context.missionRunning,false);assert.equal(s.context.missionStopRequested,true);
  assert.equal(s.context.reconMission.status,'stopped');assert.notEqual(s.context.reconMission.id,old.id);
  assert.equal(s.stored.get('mission'),before);assert.deepEqual(archived(s)[0].mission,old);
  assert.equal(s.elements.get('missionLaunchBtn').disabled,false);assert.equal(s.elements.get('missionPauseBtn').disabled,true);
  assert.equal(s.elements.get('missionLandBtn').disabled,false);assert.match(s.elements.get('missionStorageWarning').textContent,/unsaved/);
  s.context.renderMissionCockpit();assert.equal(s.elements.get('missionStorageWarning').style.display,'block');
});

for(const raw of ['{broken','null','42','true','[]','"text"','{}','{"cells":[],"candidates":[null]}','{"cells":[],"candidates":[],"exclusions":{}}']) {
  for(const action of ['clear','launch'])test(`unreadable ACTIVE ${raw} survives actual load, export and ${action}`,async()=>{
    const s=setup([]);s.stored.set('mission',raw);assert.doesNotThrow(()=>s.load());
    assert.equal(s.context.reconMission,null);assert.equal(s.stored.get('mission'),raw);
    assert.equal(s.context.missionHistoryExport().activeRaw,raw);assert.equal(s.context.saveReconMission(),true);assert.equal(s.stored.get('mission'),raw);
    installClear(s);const finish=installLaunch(s);
    if(action==='clear')s.context.clearReconMission();else{const pending=s.context.launchReconMission();finish();await pending;}
    assert.equal(archived(s).length,1);assert.equal(archived(s)[0].activeRaw,raw);
    if(action==='clear')assert.equal(s.stored.has('mission'),false);else assert.equal(s.saved().status,'complete');
  });
}

for(const action of ['clear','launch'])test(`unreadable ACTIVE cannot be lost by ${action} when its archive fails`,async()=>{
  const s=setup([]),raw=' { broken exact bytes\n';s.stored.set('mission',raw);s.load();installClear(s);installLaunch(s);
  s.context.localStorage.setItem=()=>{throw Error('quota');};let workers=0;s.context.runMissionWorker=async()=>workers++;
  if(action==='clear')s.context.clearReconMission();else await s.context.launchReconMission();
  assert.equal(workers,0);assert.equal(s.context.reconMission,null);assert.equal(s.stored.get('mission'),raw);
  assert.equal(s.context.missionHistoryExport().activeRaw,raw);assert.equal(archived(s).length,0);
});

test('export then explicitly confirmed archive removal recovers quota while cancel, later archives and ACTIVE remain safe',async()=>{
  const s=setup([lead('a')]);s.load();installClear(s);
  assert.equal(s.context.archiveReconMission('prior-1'),true);
  s.context.reconMission.candidates[0].id='b';s.context.saveReconMission();assert.equal(s.context.archiveReconMission('prior-2'),true);
  s.context.reconMission.candidates[0].id='active';s.context.saveReconMission();const active=s.stored.get('mission');
  const originalEntries=[...s.stored].filter(([key])=>key.startsWith(historyKey));const set=s.context.localStorage.setItem;
  let quota=true;s.context.localStorage.setItem=(key,value)=>{if(quota&&key.startsWith(historyKey)&&archived(s).length>=2)throw Error('quota');set(key,value);};
  s.context.clearReconMission();assert.equal(s.stored.get('mission'),active);assert.equal(archived(s).length,2);
  s.context.removeExportedMissionArchives();assert.equal(archived(s).length,2);assert.match(s.elements.get('missionStorageWarning').textContent,/Export History first/);
  let blob,revoked=false,delayed,confirmation;
  s.context.URL={createObjectURL:value=>{blob=value;return 'blob:export';},revokeObjectURL:()=>revoked=true};
  s.context.setTimeout=callback=>{delayed=callback;};s.context.exportMissionHistory();
  const exported=JSON.parse(await blob.text());assert.deepEqual(Object.fromEntries(exported.archiveRaw.map(({key,raw})=>[key,raw])),Object.fromEntries(originalEntries));
  assert.equal(revoked,false);delayed();assert.equal(revoked,true);
  s.context.confirm=message=>{confirmation=message;return false;};s.context.removeExportedMissionArchives();
  assert.match(confirmation,/saved and opened/);assert.equal(archived(s).length,2);assert.equal(s.stored.get('mission'),active);
  quota=false;s.context.archiveReconMission('after-export');quota=true;const later=archived(s).find(x=>x.reason==='after-export'),laterBytes=s.stored.get(later.key);
  s.context.confirm=()=>true;s.context.removeExportedMissionArchives();
  assert.equal(archived(s).length,1);assert.equal(s.stored.get(later.key),laterBytes);assert.equal(s.stored.get('mission'),active);
  assert.equal(s.context.reconMission.candidates[0].id,'active');
  s.context.reconMission.candidates[0].id='updated';s.context.saveReconMission();s.context.clearReconMission();
  assert.equal(s.context.reconMission,null);assert.equal(archived(s).length,2);assert.equal(s.stored.has('mission'),false);
});

test('archive export trusts real storage keys and dates, and removal errors are distinct from save failures',()=>{
  const s=setup([]);s.load();
  const entry={version:1,mission:{id:'old'},reason:'fixture',archivedAt:'2020-01-01'};
  s.stored.set(historyKey+'z',JSON.stringify({...entry,key:'mission'}));
  s.stored.set(historyKey+'a',JSON.stringify({...entry,archivedAt:'2021-01-01'}));
  const records=s.context.readMissionHistory().archived;assert.deepEqual(Array.from(records,x=>x.key),[historyKey+'z',historyKey+'a']);
  s.context.exportMissionHistory();s.context.confirm=()=>true;s.context.localStorage.removeItem=()=>{throw Error('denied');};
  s.context.removeExportedMissionArchives();assert.match(s.elements.get('missionStorageWarning').textContent,/Could not remove all exported archives/);
  assert.equal(archived(s).length,2);assert.equal(s.saved().id,'mission-id');
  installClear(s);s.context.clearReconMission();assert.match(s.elements.get('missionStorageWarning').textContent,/Could not remove the active mission/);
});

test('actual worker initial save failure stops before network and retains its pending cell for retry',async()=>{
  const s=setup([lead('history',{manualReviewHistory:[{decision:{reason:'Keep'}}]})]);s.load();installWorker(s);
  const before=s.stored.get('mission');let scans=0;s.context.RunEngine.scanZones=async()=>{scans++;return [];};
  s.context.localStorage.setItem=()=>{throw Error('quota');};s.context.missionRunning=true;
  await s.context.runMissionWorker('worker');
  assert.equal(scans,0);assert.equal(s.requests.length,0);assert.equal(s.context.missionStopRequested,true);
  assert.equal(s.context.missionRunning,true);assert.equal(s.context.reconMission.cells[0].status,'pending');
  assert.equal(s.context.reconMission.cells[0].attempts,0);assert.equal(s.elements.get('missionPauseBtn').disabled,true);
  assert.equal(s.stored.get('mission'),before);assert.equal(s.context.reconMission.candidates[0].manualReviewHistory[0].decision.reason,'Keep');
});

test('actual launched workers settle after save failure without overlapping replacement or throwing from finally',async()=>{
  const s=setup([]);s.load();installClear(s);installLaunch(s);installWorker(s);s.elements.get('missionRadius').value=18;
  const deferred=[];s.context.RunEngine.scanZones=()=>new Promise(resolve=>deferred.push(resolve));s.context.RunEngine.clusterZones=()=>[];
  const launch=s.context.launchReconMission();assert.equal(deferred.length,2);const mission=s.context.reconMission,before=s.stored.get('mission');
  const set=s.context.localStorage.setItem;s.context.localStorage.setItem=()=>{throw Error('quota while working');};
  deferred[0]([]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.context.missionRunning,true);assert.equal(s.context.missionStopRequested,true);assert.equal(mission.status,'stopped');
  assert.equal(s.elements.get('missionLandBtn').disabled,true);const archives=archived(s).length;
  await s.context.launchReconMission();s.context.clearReconMission();
  assert.equal(s.context.reconMission,mission);assert.equal(archived(s).length,archives);assert.equal(deferred.length,2);
  deferred[1]([]);await launch;
  assert.equal(s.context.missionRunning,false);assert.equal(s.elements.get('missionLaunchBtn').disabled,false);
  assert.equal(s.elements.get('missionPauseBtn').disabled,true);assert.equal(s.elements.get('missionLandBtn').disabled,false);
  assert.equal(s.stored.get('mission'),before);assert.equal(s.elements.get('missionStorageWarning').style.display,'block');
  assert.equal(mission.cells.filter(c=>c.status==='rejected').length,2);
  s.context.localStorage.setItem=set;assert.equal(s.context.saveReconMission(),true);
  assert.equal(s.elements.get('missionStorageWarning').style.display,'none');assert.equal(s.saved().status,'stopped');
});

for(const action of ['clear','launch'])for(const malformed of [false,true])test(`first-archive quota permits explicitly confirmed exported-only ${action} (${malformed?'raw':'mission'})`,async()=>{
  const s=setup([lead('large',{manualReviewHistory:[{decision:{reason:'Original review'}}]})]);
  if(malformed)s.stored.set('mission','{ unparsed original\n');s.load();installClear(s);const finish=installLaunch(s);
  const before=s.stored.get('mission'),snapshot=clone(s.context.reconMission);let exported,confirmation;
  s.context.URL.createObjectURL=blob=>{exported=blob;return 'blob:export';};s.context.exportMissionHistory();
  const exportedData=JSON.parse(await exported.text());assert.equal(exportedData.activeStoredRaw,before);assert.deepEqual(exportedData.active,snapshot);
  const set=s.context.localStorage.setItem;s.context.localStorage.setItem=(key,value)=>{if(key.startsWith(historyKey))throw Error('first archive quota');set(key,value);};
  s.context.confirm=message=>{confirmation=message;return false;};
  if(action==='clear')s.context.clearReconMission();else await s.context.launchReconMission();
  assert.equal(s.stored.get('mission'),before);assert.equal(archived(s).length,0);assert.match(confirmation,/saved and opened/);assert.match(confirmation,/ONLY archive/);
  s.context.confirm=()=>true;
  if(action==='clear')s.context.clearReconMission();else{const pending=s.context.launchReconMission();finish();await pending;}
  assert.equal(archived(s).length,0);
  if(action==='clear'){assert.equal(s.context.reconMission,null);assert.equal(s.stored.has('mission'),false);}
  else{assert.equal(s.saved().status,'complete');assert.notEqual(s.stored.get('mission'),before);}
  assert.equal(exportedData.activeStoredRaw,before);assert.deepEqual(exportedData.active,snapshot);
});

for(const change of ['ram','stored','raw','failed-export'])test(`export-only archive fallback stays blocked after ${change} changes`,()=>{
  const s=setup([lead('kept')]);if(change==='raw')s.stored.set('mission','{broken');s.load();installClear(s);
  s.context.exportMissionHistory();
  if(change==='ram')s.context.reconMission.candidates[0].manualReviewHistory=[{decision:{reason:'New unexported review'}}];
  if(change==='stored')s.stored.set('mission',s.stored.get('mission')+' ');
  if(change==='raw'){s.context.missionActiveRaw='{new unexported raw';s.stored.set('mission',s.context.missionActiveRaw);}
  if(change==='failed-export'){s.context.URL.createObjectURL=()=>{throw Error('download failed');};s.context.exportMissionHistory();}
  const before=s.stored.get('mission'),live=s.context.reconMission;let confirmations=0;s.context.confirm=()=>{confirmations++;return true;};
  s.context.localStorage.setItem=()=>{throw Error('quota');};s.context.clearReconMission();
  assert.equal(confirmations,0);assert.equal(s.stored.get('mission'),before);assert.equal(s.context.reconMission,live);assert.equal(archived(s).length,0);
});
