import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function setup() {
  const elements=new Map(),answers=[],effects={saved:0,drawn:0,stopped:0};
  const candidate={id:'lead',lat:45,lng:-112,verdict:'reject',rejectReason:'Original area',rejectedAt:'2026-10-20T00:00:00Z',
    flags:['inside_rejected_area','legal_access_unverified'],score:40,qualifyingSamples:4,verticalM:200,clusterSpanM:300,aspect:'N',agent:'fixture',catAccess:null,
    manualReview:{verdict:'reject',reason:'Original area',source:'area',at:'2026-10-20T00:00:00Z',exclusionId:'old-area'}};
  const mission={name:'Fixture',status:'complete',cells:[],candidates:[candidate],exclusions:[],errors:0,rejected:0};
  const context=vm.createContext({reconMission:mission,missionPaused:false,missionParcelGeometry:new Map(),
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{style:{},innerHTML:''});return elements.get(id);}},
    map:{getBounds:()=>({getSouth:()=>45.001,getNorth:()=>45.003,getWest:()=>-112.003,getEast:()=>-112.001})},
    prompt:()=>answers.shift(),alert:message=>{throw Error(message);},saveReconMission:()=>effects.saved++,drawMissionCandidates:()=>effects.drawn++});
  const escape=html.slice(html.indexOf('function escapeHtml('),html.indexOf('function applyMissionPreset('));
  const land=html.slice(html.indexOf('function escapeLandText('),html.indexOf('function publicNullableNumber('));
  const handlers=html.slice(html.indexOf('function rejectCurrentMapArea('),html.indexOf('function drawMissionCandidates('));
  vm.runInContext(escape+land+handlers,context);
  function scan(lat=45.002,lng=-112.002,extra={}) {
    context.replaceMissionCandidateEvidence(candidate,{lat,lng,verdict:'advance',score:60,qualifyingSamples:5,flags:[],...extra});
    context.renderMissionCockpit();
  }
  scan();
  assert.ok(candidate.flags.includes('prior_area_rejection_retained'));
  return {context,candidate,mission,answers,effects,scan,output:()=>elements.get('missionReports').innerHTML,
    event:{stopPropagation:()=>effects.stopped++}};
}

test('fresh manual reject clears inherited-location wording through real handler, renderer and rescans',()=>{
  const s=setup(),reason='Current "plot" <script>reason</script> & \'quote\'';
  s.answers.push(reason);s.context.rejectMissionCandidate(s.event,'lead');
  assert.equal(s.candidate.rejectReason,reason);assert.equal(s.candidate.manualReview.source,'candidate');
  assert.equal(s.candidate.manualReview.position.lat,45.002);
  assert.ok(!s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location|<script>reason/);
  assert.ok(s.output().includes(s.context.escapeHtml(reason)));
  assert.match(s.output(),/&quot;plot&quot;.*&lt;script&gt;reason&lt;\/script&gt;.*&amp;.*&#39;quote&#39;/);
  const history=JSON.stringify(s.candidate.manualReviewHistory);
  s.scan(45.002,-112.002,{manualReviewHistory:[]});
  s.scan(45.004,-112.004);
  assert.equal(s.candidate.verdict,'reject');assert.equal(s.candidate.rejectReason,reason);
  assert.ok(!s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location/);
  assert.equal(JSON.stringify(s.candidate.manualReviewHistory),history);
  const prior=JSON.parse(history)[0].before;
  assert.equal(prior.reason,'Original area');assert.equal(prior.manualReview.source,'area');
  assert.ok(prior.flags.includes('prior_area_rejection_retained'));
});

test('sideline then reject append decision provenance without resurrecting inherited area flags',()=>{
  const s=setup();s.answers.push('Inspect current access');s.context.sidelineMissionCandidate(s.event,'lead');
  assert.equal(s.candidate.verdict,'sideline');assert.equal(s.candidate.rejectedAt,undefined);
  assert.equal(s.candidate.manualReview.verdict,'sideline');assert.equal(s.candidate.manualReview.reason,'Inspect current access');
  assert.ok(!s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location/);
  const first=JSON.stringify(s.candidate.manualReviewHistory[0]);
  s.scan();assert.equal(s.candidate.verdict,'sideline');
  s.answers.push('Reject at this location');s.context.rejectMissionCandidate(s.event,'lead');s.scan();
  assert.equal(s.candidate.manualReviewHistory.length,2);
  assert.equal(JSON.stringify(s.candidate.manualReviewHistory[0]),first);
  const saved=JSON.parse(JSON.stringify(s.candidate));
  assert.equal(saved.manualReviewHistory[0].before.reason,'Original area');
  assert.equal(saved.manualReviewHistory[0].decision.verdict,'sideline');
  assert.equal(saved.manualReviewHistory[1].before.reason,'Inspect current access');
  assert.equal(saved.manualReviewHistory[1].decision.reason,'Reject at this location');
  assert.equal(saved.manualReview.verdict,'reject');
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location/);
});

test('fresh area rejection replaces stale manual provenance and keeps one applicable location flag',()=>{
  const s=setup();s.answers.push('Manual follow-up');s.context.sidelineMissionCandidate(s.event,'lead');
  s.answers.push('New mapped exclusion');s.context.rejectCurrentMapArea();
  assert.equal(s.mission.exclusions.length,1);assert.equal(s.candidate.manualReview.source,'area');
  assert.equal(s.candidate.manualReview.exclusionId,s.mission.exclusions[0].id);
  assert.equal(s.candidate.manualReview.reason,'New mapped exclusion');
  assert.ok(s.candidate.flags.includes('inside_rejected_area'));
  assert.ok(!s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location/);
  const history=JSON.stringify(s.candidate.manualReviewHistory);
  s.scan(45.004,-112.004);
  assert.ok(s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.ok(!s.candidate.flags.includes('inside_rejected_area'));
  assert.match(s.output(),/Rejection retained from an earlier location: New mapped exclusion/);
  assert.equal(JSON.stringify(s.candidate.manualReviewHistory),history);
});

test('new candidate decision within a current area does not inherit area provenance on a later move',()=>{
  const s=setup();s.answers.push('Current area');s.context.rejectCurrentMapArea();
  s.answers.push('Current manual reason');s.context.rejectMissionCandidate(s.event,'lead');
  assert.ok(s.candidate.flags.includes('inside_rejected_area'));
  s.scan(45.004,-112.004);
  assert.equal(s.candidate.rejectReason,'Current manual reason');
  assert.ok(!s.candidate.flags.includes('prior_area_rejection_retained'));
  assert.doesNotMatch(s.output(),/Rejection retained from an earlier location/);
});

test('prior decision snapshots are detached from later mutable review and flags',()=>{
  const s=setup(),oldReview=s.candidate.manualReview,oldFlags=s.candidate.flags;
  s.answers.push('Fresh reject');s.context.rejectMissionCandidate(s.event,'lead');
  oldReview.reason='changed elsewhere';oldFlags.push('later flag');s.candidate.manualReview.reason='later current edit';
  const entry=s.candidate.manualReviewHistory[0];
  assert.equal(entry.before.manualReview.reason,'Original area');assert.ok(!entry.before.flags.includes('later flag'));
  assert.equal(entry.decision.reason,'Fresh reject');
});

for(const answer of [null,'','   ']) test(`cancelled/empty decisions leave provenance and saved state untouched (${JSON.stringify(answer)})`,()=>{
  for(const handler of ['rejectMissionCandidate','sidelineMissionCandidate','rejectCurrentMapArea']) {
    const s=setup(),before=JSON.stringify(s.mission),saved=s.effects.saved,drawn=s.effects.drawn;
    s.answers.push(answer);
    if(handler==='rejectCurrentMapArea')s.context[handler]();else s.context[handler](s.event,'lead');
    assert.equal(JSON.stringify(s.mission),before);assert.equal(s.effects.saved,saved);assert.equal(s.effects.drawn,drawn);
  }
});
