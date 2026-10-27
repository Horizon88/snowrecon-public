import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const engineSource = await readFile(new URL('../run-engine.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bounds = { south: 42.999, north: 43.001, west: 140.999, east: 141.001 };
function engine(fetch = async () => ({ ok: false })) {
  const context = vm.createContext({ fetch, setTimeout, clearTimeout, console });
  vm.runInContext(`${engineSource}\nglobalThis.engine = RunEngine;`, context);
  return context.engine;
}
async function flatEngine(text) {
  const flat = text ?? Array.from({ length: 256 }, () => Array(256).fill('1000').join(',')).join('\n');
  return engine(async () => ({ ok: true, text: async () => flat }));
}
function erase(e, lat, lng) {
  const p = e.latLngToTile(lat, lng, 14);
  e.parsedCache[`14/${p.tileX}/${p.tileY}`][p.pixelY*256+p.pixelX] = NaN;
}

test('fully measured flat sampled terrain remains a numerical rejection', async () => {
  const e = await flatEngine(), scan = await e.scanZones(bounds, 2, null, { minElevation: 0 });
  assert.equal(scan.coverage.complete, true);
  assert.equal(scan.coverage.measuredSamples, 4);
  assert.equal(e.screenMissionZones(e.clusterZones(scan.samples), scan.coverage).status, 'rejected');
});
test('failed DEM requests are unknown, never a numerical rejection', async () => {
  const e = engine(), scan = await e.scanZones(bounds, 2, null, { minElevation: 0 });
  assert.equal(scan.coverage.missingElevationSamples, 4);
  assert.equal(scan.coverage.complete, false);
  assert.equal(e.screenMissionZones([], scan.coverage).status, 'data_review');
});
test('one missing grid sample retains the cell for data review', async () => {
  const e = await flatEngine(); await e.prefetchTiles(43, 141, 2);
  erase(e, 42.9995, 140.9995);
  const scan = await e.scanZones(bounds, 2, null, { minElevation: 0 });
  assert.ok(scan.coverage.missingElevationSamples > 0);
  assert.equal(e.screenMissionZones([], scan.coverage).status, 'data_review');
});
test('finite centre with missing slope neighbour is incomplete', async () => {
  const e = await flatEngine(); await e.prefetchTiles(43, 141, 2);
  erase(e, 43.0005, 141);
  const scan = await e.scanZones(bounds, 1, null, { minElevation: 0 });
  assert.equal(scan.coverage.missingElevationSamples, 0);
  assert.equal(scan.coverage.missingSlopeSamples, 1);
  assert.equal(scan.coverage.complete, false);
});
test('short DEM text leaves absent pixels unknown instead of filling them with zero', async () => {
  const e = await flatEngine('1000');
  const scan = await e.scanZones(bounds, 1, null, { minElevation: -100 });
  assert.equal(scan.coverage.missingElevationSamples, 1);
  assert.equal(scan.coverage.complete, false);
});
test('missing DEM along a downhill trace cannot masquerade as measured runout', async () => {
  const e = engine();
  const center = e.latLngToTile(43, 141, 14), baseY = center.tileY*256+center.pixelY;
  for (let y=center.tileY-2;y<=center.tileY+2;y++) for(let x=center.tileX-2;x<=center.tileX+2;x++) {
    const values=new Float32Array(256*256);
    for(let py=0;py<256;py++) for(let px=0;px<256;px++) values[py*256+px]=1000+Math.max(0,y*256+py-(baseY-100))*3;
    e.parsedCache[`14/${x}/${y}`]=values;
  }
  const hole=e.latLngToTile(43+80/111320,141,14);
  for(let dy=-2;dy<=2;dy++) for(let dx=-5;dx<=5;dx++) {
    e.parsedCache[`14/${hole.tileX}/${hole.tileY}`][(hole.pixelY+dy)*256+hole.pixelX+dx]=NaN;
  }
  const scan=await e.scanZones(bounds,1,null,{minElevation:0,minVerticalDrop:150});
  assert.equal(scan.coverage.missingElevationSamples,0);
  assert.equal(scan.coverage.missingSlopeSamples,0);
  assert.equal(scan.coverage.incompleteTraces,1);
  assert.equal(e.screenMissionZones([],scan.coverage).status,'data_review');
});
test('150m is retained, 250m preferred, width and descending rank preserved', () => {
  const e=engine(), zones=[149,150,249,250].map(maxVert=>({maxVert,width:200,pointCount:2}));
  zones.push({maxVert:500,width:199,pointCount:2});
  const result=e.screenMissionZones(zones,{complete:true});
  assert.equal(result.status,'complete');
  assert.deepEqual(Array.from(result.zones,z=>[z.maxVert,z.preferredVertical]),[[250,true],[249,false],[150,false]]);
  assert.equal(e.screenMissionZones(zones,{complete:false}).status,'data_review');
  assert.equal(e.screenMissionZones(zones,undefined).status,'data_review');
});

const workerSource = html.slice(html.indexOf('async function runMissionWorker('), html.indexOf('function toggleMissionPause('));
async function runWorker(scan, zones) {
  const actualEngine=engine(), cell={id:'test',bounds,status:'pending',attempts:0};
  const state={cells:[cell],candidates:[],rejected:0,errors:0,minElevation:250};
  let receivedOptions;
  const context=vm.createContext({ console, setTimeout, missionStopRequested:false, missionPaused:false, currentRegion:'japan', reconMission:state,
    RunEngine:{ setZoneSensitivity(){}, scanZones:async (_b,_g,_p,opts)=>{receivedOptions=opts;return scan;}, clusterZones:()=>zones,
      screenMissionZones:actualEngine.screenMissionZones, fetchRoads:async()=>[] },
    renderMissionCockpit(){},saveReconMission(){},drawMissionCandidates(){},missionCandidateSort:()=>0,
    missionHash:(lat,lng)=>`${lat}:${lng}`,findMissionExclusion:()=>null,missionDistanceM:()=>1000,checkMissionCandidateLand:async()=>{} });
  vm.runInContext(workerSource,context); await context.runMissionWorker('test-agent');
  return {state,cell,receivedOptions};
}
test('mission worker retains incomplete cell and saves coverage without incrementing rejections',async()=>{
  const result=await runWorker({samples:[],coverage:{complete:false,missingElevationSamples:1}},[]);
  assert.equal(result.cell.status,'data_review');assert.equal(result.state.rejected,0);
  assert.equal(result.cell.coverage.missingElevationSamples,1);assert.equal(result.cell.rejectReason,null);
  assert.match(result.cell.reviewReason,/incomplete/);assert.equal(result.receivedOptions.minVerticalDrop,150);
});
test('mission worker counts a complete measured failure as rejected',async()=>{
  const result=await runWorker({samples:[],coverage:{complete:true}},[]);
  assert.equal(result.cell.status,'rejected');assert.equal(result.state.rejected,1);
  assert.match(result.cell.rejectReason,/150m/);
});
test('mission worker retains 150m lead and marks partial coverage on its evidence',async()=>{
  const zone={maxVert:150,width:200,pointCount:2,maxElev:1000,minElev:850,centroidLat:43,centroidLng:141,aspectDir:'N',points:[{lat:43,lng:141,elevation:1000},{lat:43.002,lng:141,elevation:850}]};
  const result=await runWorker({samples:[],coverage:{complete:false}},[zone]);
  assert.equal(result.cell.status,'data_review');assert.equal(result.state.rejected,0);
  assert.equal(result.state.candidates.length,1);assert.equal(result.state.candidates[0].verticalM,150);
  assert.ok(result.state.candidates[0].flags.includes('terrain_coverage_incomplete'));
  assert.equal(result.state.candidates[0].preferredVertical,false);
});
test('all inline scripts remain valid JavaScript',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(match[1].trim()) new vm.Script(match[1]);
});

const flatTile = Array.from({length:256},()=>Array(256).fill('1000').join(',')).join('\n');
const productionBounds = {south:47-6/111.32,north:47+6/111.32,west:-113-6/(111.32*Math.cos(47*Math.PI/180)),east:-113+6/(111.32*Math.cos(47*Math.PI/180))};
test('production 12km US cell requests its full tile range and measured flat screen rejects',async()=>{
  const e=await flatEngine(flatTile),scan=await e.scanZones(productionBounds,18,null,{minElevation:0});
  assert.equal(scan.coverage.measuredSamples,324);assert.equal(scan.coverage.complete,true);
  assert.equal(scan.coverage.unrequestedSamples,0);assert.equal(e.screenMissionZones([],scan.coverage).status,'rejected');
});
test('one failed tile inside a production US cell remains data review, not unrequested data',async()=>{
  const coordinates=engine().latLngToTile(47,-113,14),key=`14/${coordinates.tileX}/${coordinates.tileY}`;
  const e=engine(async url=>url.includes(`/api/dem/${key}`)?{ok:false}:{ok:true,text:async()=>flatTile});
  const scan=await e.scanZones(productionBounds,18,null,{minElevation:0});
  assert.ok(scan.coverage.missingElevationSamples>0);assert.equal(scan.coverage.unrequestedSamples,0);
  assert.ok(scan.coverage.incompleteTileKeys.includes(key));assert.equal(e.screenMissionZones([],scan.coverage).status,'data_review');
});
test('trace fetches needed tiles beyond initial bounds and reaching 200steps stays data review',async()=>{
  const ref=engine().latLngToTile(43,141,14),baseY=ref.tileY*256+ref.pixelY,requested=[];
  const e=engine(async url=>{
    const key=url.match(/dem\/(14\/\d+\/\d+)/)[1];requested.push(key);const y=Number(key.split('/')[2]);
    return {ok:true,text:async()=>Array.from({length:256},(_,py)=>Array(256).fill(String(10000+(y*256+py-baseY)*3)).join(',')).join('\n')};
  });
  const scan=await e.scanZones(bounds,1,null,{minElevation:0,minVerticalDrop:150});
  assert.equal(scan.coverage.limitedTraces,1);assert.equal(scan.coverage.incompleteTraces,0);
  assert.equal(scan.coverage.unrequestedTraces,0);assert.equal(scan.coverage.complete,false);
  assert.ok(requested.some(key=>Number(key.split('/')[2])<ref.tileY-1));
  assert.equal(e.screenMissionZones([],scan.coverage).status,'data_review');
});
test('request budget deferral is explicit and is not counted as failed DEM',async()=>{
  let requests=0;const e=engine(async()=>{requests++;return {ok:false};});
  const scan=await e.scanZones({...productionBounds,west:-114.5,east:-111.5},1,null,{minElevation:0});
  assert.equal(requests,512);assert.equal(scan.coverage.newTilesRequested,512);
  assert.equal(scan.coverage.unrequestedSamples,1);assert.equal(scan.coverage.missingElevationSamples,0);
  assert.equal(scan.coverage.complete,false);assert.ok(scan.coverage.unrequestedTileKeys.length>0);
});
test('explicit retry clears only recorded failed tiles, then recovered source completes',async()=>{
  const center=engine().latLngToTile(43,141,14),bad=`14/${center.tileX}/${center.tileY}`;let failed=true;
  const e=engine(async url=>failed&&url.includes(`/api/dem/${bad}`)?{ok:false}:{ok:true,text:async()=>flatTile});
  const first=await e.scanZones(bounds,1,null,{minElevation:0});
  const good=Object.keys(e.parsedCache).find(k=>e.parsedCache[k]),saved=e.parsedCache[good];
  assert.equal(e.retryIncompleteDEMTiles([...first.coverage.incompleteTileKeys,good]),1);
  assert.equal(e.parsedCache[bad],undefined);assert.equal(e.parsedCache[good],saved);
  failed=false;const second=await e.scanZones(bounds,1,null,{minElevation:0});
  assert.equal(second.coverage.complete,true);assert.equal(second.coverage.newTilesRequested,1);
});

async function retryHarness({verdict='reject',complete=false,running=false,exclusionReason=null}={}) {
  const zone={maxVert:250,width:200,pointCount:2,maxElev:1000,minElev:750,centroidLat:43,centroidLng:141,aspectDir:'N',points:[{lat:43,lng:141,elevation:1000},{lat:43.002,lng:141,elevation:750}]};
  const mission={id:'saved-mission',status:'complete',cellKm:4,name:'Saved',minElevation:250,
    cells:[{id:'retry',bounds,status:'data_review',attempts:1,coverage:{complete:false,incompleteTileKeys:['14/1/2']}},{id:'prior-rejected',status:'rejected',attempts:1,rejectReason:'prior evidence'}],
    candidates:[{id:'manual',lat:43,lng:141,verdict,rejectReason:'User decision',score:1,manualReview:{verdict,reason:'User decision'},...(verdict==='reject'?{rejectedAt:'2026-01-01'}:{})}],
    exclusions:[{id:'saved-exclusion'}],rejected:1,errors:0};
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='missionPreset'?'current':'4',style:{}});return elements.get(id);};
  const actual=engine();let scans=0,cleared;
  const context=vm.createContext({console,setTimeout,document:{getElementById:element},missionRunning:running,missionPaused:false,missionStopRequested:false,currentRegion:'japan',reconMission:mission,
    MISSION_PRESETS:{},map:{getCenter:()=>({lat:43,lng:141})},missionCellGrid:()=>{throw Error('Existing mission must not reset');},
    RunEngine:{retryIncompleteDEMTiles:keys=>{cleared=keys;},setZoneSensitivity(){},scanZones:async()=>{scans++;return {samples:[],coverage:{complete,incompleteTileKeys:complete?[]:['14/1/2']}};},clusterZones:()=>[zone],screenMissionZones:actual.screenMissionZones,fetchRoads:async()=>[]},
    renderMissionCockpit(){},saveReconMission(){},drawMissionCandidates(){},missionCandidateSort:()=>0,missionHash:()=> 'new-id',findMissionExclusion:()=>exclusionReason?{reason:exclusionReason}:null,missionDistanceM:()=>0,checkMissionCandidateLand:async()=>{},alert:message=>{throw Error(message);} });
  const lifecycle=html.slice(html.indexOf('async function retryMissionDataReview('),html.indexOf('function toggleMissionPause('));
  vm.runInContext(lifecycle,context);await context.launchReconMission();return {state:context.reconMission,scans,cleared};
}
test('explicit retry preserves mission, decisions, exclusions and prior evidence without automatic loops',async()=>{
  const {state,scans,cleared}=await retryHarness();
  assert.equal(scans,1);assert.equal(state.id,'saved-mission');assert.equal(state.status,'complete');
  assert.equal(state.cells[0].status,'data_review');assert.equal(state.cells[1].status,'rejected');
  assert.equal(state.rejected,1);assert.equal(state.exclusions[0].id,'saved-exclusion');
  assert.equal(state.candidates.length,1);assert.equal(state.candidates[0].id,'manual');
  assert.equal(state.candidates[0].verdict,'reject');assert.equal(state.candidates[0].rejectReason,'User decision');
  assert.equal(state.retryHistory.length,1);assert.equal(state.retryHistory[0].cells[0].status,'data_review');
  assert.equal(state.retryHistory[0].candidates[0].score,1);assert.ok(state.candidates[0].score>1);
  assert.deepEqual(Array.from(cleared),['14/1/2']);
});
test('successful explicit retry preserves a user sidelining decision and all prior rejected cells',async()=>{
  const {state,scans}=await retryHarness({verdict:'sideline',complete:true});
  assert.equal(scans,1);assert.equal(state.cells[0].status,'complete');assert.equal(state.cells[1].status,'rejected');
  assert.equal(state.candidates[0].verdict,'sideline');assert.equal(state.candidates[0].rejectReason,'User decision');
  assert.equal(state.retryHistory[0].cells[0].coverage.complete,false);
});
test('retry refuses to overlap an active mission',async()=>{
  const {state,scans,cleared}=await retryHarness({running:true});
  assert.equal(scans,0);assert.equal(cleared,undefined);assert.equal(state.retryHistory,undefined);
});

test('a saved sidelining decision cannot override a mapped exclusion found on retry',async()=>{
  const {state}=await retryHarness({verdict:'sideline',complete:true,exclusionReason:'Saved excluded area'});
  assert.equal(state.candidates[0].verdict,'reject');assert.equal(state.candidates[0].rejectReason,'Saved excluded area');
  assert.equal(state.retryHistory[0].candidates[0].verdict,'sideline');
});
