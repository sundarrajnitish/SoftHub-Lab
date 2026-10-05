// Evaluate the review sentiment model on the hand-labelled sets.
//   node sim/eval-sentiment.mjs            → prints metrics, writes results/sentiment.json
//   node sim/eval-sentiment.mjs --errors   → also lists misclassified dev reviews
//
// data/reviews_dev.jsonl was used while building the lexicon; data/
// reviews_test.jsonl was held out and only scored at the end.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { analyseReview } from '../packages/core/src/sentiment.js';

const LABELS = ['positive', 'neutral', 'negative'];
const load = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

export function evaluate(rows) {
  const confusion = Object.fromEntries(LABELS.map((a) => [a, Object.fromEntries(LABELS.map((b) => [b, 0]))]));
  const errors = [];
  let polarHit = 0, polarN = 0;
  for (const r of rows) {
    const a = analyseReview(r.text);
    confusion[r.label][a.label]++;
    if (a.label !== r.label) errors.push({ ...r, predicted: a.label, compound: a.compound });
    if (r.label !== 'neutral') { polarN++; if (a.label === r.label) polarHit++; }
  }
  const per = {};
  for (const l of LABELS) {
    const tp = confusion[l][l];
    const fp = LABELS.reduce((s, o) => s + (o !== l ? confusion[o][l] : 0), 0);
    const fn = LABELS.reduce((s, o) => s + (o !== l ? confusion[l][o] : 0), 0);
    const p = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0;
    per[l] = { precision: round(p), recall: round(rc), f1: round(p + rc ? (2 * p * rc) / (p + rc) : 0), n: tp + fn };
  }
  const correct = LABELS.reduce((s, l) => s + confusion[l][l], 0);
  const majority = Math.max(...LABELS.map((l) => per[l].n)) / rows.length;
  return {
    n: rows.length,
    accuracy: round(correct / rows.length),
    macroF1: round(LABELS.reduce((s, l) => s + per[l].f1, 0) / 3),
    polarAccuracy: round(polarHit / polarN),
    majorityBaseline: round(majority),
    perClass: per,
    confusion,
    errors,
  };
}

const round = (x) => Math.round(x * 1000) / 1000;

if (import.meta.url === `file://${process.argv[1]}`) {
  const dev = evaluate(load('reviews_dev.jsonl'));
  const test = evaluate(load('reviews_test.jsonl'));
  const show = (name, r) => console.log(`${name.padEnd(5)} n=${r.n}  accuracy ${r.accuracy}  macro-F1 ${r.macroF1}  pos/neg accuracy ${r.polarAccuracy}  (majority baseline ${r.majorityBaseline})`);
  show('dev', dev);
  show('test', test);
  if (process.argv.includes('--errors')) for (const e of dev.errors) console.log(`  [${e.label}→${e.predicted} ${e.compound}] ${e.text}`);
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const strip = ({ errors, ...r }) => ({ ...r, errors: errors.map(({ text, label, predicted, compound }) => ({ text, label, predicted, compound })) });
  writeFileSync(new URL('../results/sentiment.json', import.meta.url), JSON.stringify({ dev: strip(dev), test: strip(test) }, null, 2));
}
