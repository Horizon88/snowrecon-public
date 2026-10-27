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
