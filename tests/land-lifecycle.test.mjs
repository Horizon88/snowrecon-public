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
