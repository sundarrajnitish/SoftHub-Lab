// Lab 5: live sentiment, token by token, plus the evaluation results.
import { h, $, mount, chip } from './ui.js';
import { analyseReview } from './core/sentiment.js';
import { barChart } from './charts.js';

const PRESETS = [
  ['Mixed', 'The interface is clean and really intuitive. But it crashes when I export 4K, and support never answered.'],
  ['Negation', 'Not bad at all. Never crashed once, no complaints.'],
  ['Shouting', 'WORST purchase ever. Do not buy!!!'],
  ['Value', 'Pricey, but worth every penny. Rendering is super fast.'],
  ['Neutral', 'Installed it on two machines last week.'],
];

export function initReviews(app, R) {
  const ta = $('#rv-text');
  mount($('#rv-presets'), PRESETS.map(([name, text]) => h('button', { class: 'chip', onclick: () => { ta.value = text; update(); } }, name)));
  ta.addEventListener('input', update);
  update();
  results(R);

  function update() {
    const a = analyseReview(ta.value);
    const toks = [];
    for (const sent of a.sentences) {
      for (const t of sent.tokens) {
        const v = t.value;
        const strength = Math.min(1, Math.abs(v) / 3);
        const bg = v > 0 ? `color-mix(in srgb, var(--good) ${Math.round(strength * 45 + 8)}%, transparent)` : v < 0 ? `color-mix(in srgb, var(--bad) ${Math.round(strength * 45 + 8)}%, transparent)` : 'transparent';
        const marks = [t.negated && '¬', t.boost && '↑', t.contrast === 0.5 && '½', t.contrast === 1.5 && '1½', t.caps && '⇧'].filter(Boolean).join('');
        const tip = t.base ? `base ${t.base} → ${v.toFixed(2)}${t.negated ? ' · negated' : ''}${t.boost ? ` · boost ${t.boost.toFixed(2)}` : ''}${t.contrast ? ` · ×${t.contrast} (but-clause)` : ''}${t.aspect ? ` · aspect: ${t.aspect}` : ''}` : (t.aspect ? `aspect: ${t.aspect}` : '');
        toks.push(h('span', { class: `tok${tip ? ' has' : ''}`, title: tip, style: { background: bg, textDecoration: t.aspect ? 'underline dotted' : 'none' } }, t.text, marks ? h('sup', {}, marks) : null));
      }
      toks.push(h('span', { class: 'muted' }, ' · '));
    }
    toks.pop();
    mount($('#rv-tokens'), toks);
    $('#rv-score').textContent = (a.compound >= 0 ? '+' : '') + a.compound.toFixed(3);
    $('#rv-gauge').style.left = `${((a.compound + 1) / 2) * 100}%`;
    const kind = a.label === 'positive' ? 'good' : a.label === 'negative' ? 'bad' : 'warn';
    mount($('#rv-label'), a.label);
    $('#rv-label').className = `chip ${kind}`;
    const asp = Object.entries(a.aspects);
    mount($('#rv-aspects'), asp.length ? asp.map(([k, v]) => h('div', { class: 'aspect' }, h('span', {}, k),
      h('span', { class: 'bar center' }, h('i', { class: v >= 0 ? 'pos' : 'neg', style: { width: `${Math.min(50, Math.abs(v) * 50)}%` } })),
      h('span', { class: 'small num muted' }, v.toFixed(2)))) : h('p', { class: 'small muted' }, 'No aspect words (price, speed, crashes, interface, activation, support, features).'));
  }
}

function results(R) {
  const t = R.sentiment.test, d = R.sentiment.dev;
  $('#ev-blurb').textContent = `${t.n} reviews written and labelled for this project and kept out of tuning. Accuracy ${(t.accuracy * 100).toFixed(1)} % (majority-class baseline ${(t.majorityBaseline * 100).toFixed(1)} %), macro-F1 ${t.macroF1.toFixed(2)}, positive-vs-negative accuracy ${(t.polarAccuracy * 100).toFixed(1)} %. On the ${d.n}-review development set used to build the lexicon: ${(d.accuracy * 100).toFixed(1)} %.`;
  const L = ['positive', 'neutral', 'negative'];
  mount($('#confusion'),
    h('thead', {}, h('tr', {}, h('th', {}, 'labelled ↓ / predicted →'), L.map((l) => h('th', {}, l)), h('th', {}, 'recall'))),
    h('tbody', {}, L.map((row) => h('tr', {}, h('th', {}, row), L.map((col) => h('td', { class: row === col ? 'diag' : '' }, t.confusion[row][col])), h('td', {}, t.perClass[row].recall.toFixed(2))))));
  const m = R.sentiment.meanCompoundByStars;
  const stars = Object.keys(m).sort();
  // shift to 0..2 for the bar scale, label with the real value
  barChart($('#ch-stars'), { w: 420, h: 200, labels: stars.map((x) => `${x}★ (n=${R.sentiment.reviewsByStars?.[x] ?? '?'})`), values: stars.map((x) => m[x] + 1), valueFmt: (v) => (v - 1).toFixed(1), classes: stars.map((x) => (m[x] >= 0 ? '' : 'alt')) });
  $('#ev-agree').textContent = `Bars show the mean compound score (−1 to +1) by star rating. Text and stars agree on ${(R.sentiment.starAgreement * 100).toFixed(1)} % of 4–5★ and 1–2★ reviews; the rest are flagged to providers as rating/text mismatches.`;
}

export { chip };
