import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function missionEvidenceSummary(');
const end = html.indexOf('\nfunction renderMissionCockpit()', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(html.slice(start, end), context);
const summarize = context.missionEvidenceSummary;

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
