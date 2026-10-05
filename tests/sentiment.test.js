import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyseReview, scoreSentence, reviewDeltas, summarise, isMismatch } from '../packages/core/src/sentiment.js';
import { evaluate } from '../sim/eval-sentiment.mjs';

const c = (t) => analyseReview(t).compound;

test('polarity, negation, boosters, contrast and phrases', () => {
  assert.ok(c('Great app') > 0.5);
  assert.ok(c('Terrible app') < -0.5);
  assert.ok(c('not good') < 0, 'negation flips');
  assert.ok(c('very good') > c('good'), 'booster amplifies');
  assert.ok(c('slightly good') < c('good'), 'dampener reduces');
  assert.ok(c('GREAT app, love the design') > c('great app, love the design'), 'caps emphasis');
  assert.ok(c('Good!!!') > c('Good'), 'exclamation emphasis');
  assert.ok(c('It looks nice but it crashes constantly') < 0, 'clause after "but" dominates');
  assert.ok(c('Waste of money') < -0.5);
  assert.ok(c('Worth every penny') > 0.5);
  assert.ok(c('Not bad at all') > 0);
  assert.ok(c('Never crashes') > 0);
  assert.equal(c('It is a video converter.'), 0);
});

test('token trace explains the score', () => {
  const s = scoreSentence('The UI is not intuitive');
  const tok = s.tokens.find((t) => t.text === 'intuitive');
  assert.ok(tok.negated);
  assert.ok(tok.value < 0 && tok.base > 0);
  assert.equal(s.tokens.find((t) => t.text === 'UI').aspect, 'usability');
});

test('aspects are scored per sentence', () => {
  const a = analyseReview('The interface is clean and intuitive. But it crashes every day and support never answers.');
  assert.ok(a.aspects.usability > 0);
  assert.ok(a.aspects.stability < 0);
});

test('review deltas are exact integers and reverse cleanly', () => {
  const a = analyseReview('Fast and stable, but too expensive.');
  const add = reviewDeltas(4, a, 1);
  const sub = reviewDeltas(4, a, -1);
  for (const [k, v] of Object.entries(add)) {
    assert.ok(Number.isInteger(v));
    assert.equal(v + sub[k], 0);
  }
});

test('summary headline and highlights', () => {
  const reviews = ['Fast and reliable, love it.', 'Great value and very stable.', 'Crashes constantly. Awful.']
    .map((text, i) => ({ text, reviewId: `r${i}`, stars: i < 2 ? 5 : 1 }));
  const agg = {};
  for (const r of reviews) for (const [k, v] of Object.entries(reviewDeltas(r.stars, analyseReview(r.text)))) agg[k] = (agg[k] || 0) + v;
  const s = summarise(agg, reviews);
  assert.equal(s.reviews, 3);
  assert.equal(s.split.positive, 2);
  assert.match(s.headline, /mostly positive/);
  assert.ok(s.highlights.praise.compound > 0.3);
  assert.ok(s.highlights.complaint.compound < -0.3);
  assert.ok(isMismatch(5, -0.6) && !isMismatch(5, 0.6));
});

test('held-out evaluation set: accuracy well above the majority baseline', () => {
  const rows = readFileSync(new URL('../data/reviews_test.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const r = evaluate(rows);
  assert.ok(r.accuracy >= 0.8, `accuracy ${r.accuracy}`);
  assert.ok(r.polarAccuracy >= 0.85, `pos/neg accuracy ${r.polarAccuracy}`);
  assert.ok(r.accuracy > r.majorityBaseline + 0.3);
});
