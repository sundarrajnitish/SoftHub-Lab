// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Review sentiment and aspect analysis.
//
// A rule-based, lexicon model in the spirit of VADER (Hutto & Gilbert, 2014),
// with its own lexicon tuned to software reviews ("crashes", "bloated",
// "activation", "seamless", ...). It was chosen over a hosted language model
// because it is:
//   • explainable — every point of the score comes from a visible word and rule
//     (the website colours each token by its contribution);
//   • instant and free — runs inside the review Lambda in < 1 ms, no GPU
//     endpoint to keep warm, no per-token bill, works in the browser;
//   • deterministic — the same review always gets the same score, so stored
//     aggregates can be recomputed and tested exactly.
// tests/sentiment.test.js and sim/eval-sentiment.mjs measure it against a
// hand-labelled evaluation set (data/reviews_eval.jsonl).

// valence in [-4, 4]
export const LEXICON = {
  // general positive
  good: 1.9, great: 3.1, excellent: 3.3, amazing: 3.2, awesome: 3.1, fantastic: 3.3, superb: 3.2,
  perfect: 3.0, perfectly: 2.6, love: 3.0, loved: 2.9, loves: 2.8, liked: 1.6, likes: 1.4, enjoy: 2.2, enjoyed: 2.3,
  best: 3.0, better: 1.8, nice: 1.8, solid: 1.9, brilliant: 3.0, wonderful: 3.1, happy: 2.6, glad: 2.0,
  pleased: 2.2, impressed: 2.5, impressive: 2.6, recommend: 2.0, recommended: 2.0, worth: 1.9,
  helpful: 2.0, useful: 1.9, beautiful: 2.6, gorgeous: 2.8, fun: 2.3, addictive: 1.6, polished: 2.3,
  reliable: 2.4, dependable: 2.2, stable: 1.9, smooth: 2.2, smoothly: 2.0, fast: 1.9, quick: 1.6, quickly: 1.5,
  snappy: 2.2, snappier: 2.0, faster: 1.6, responsive: 2.0, lightweight: 1.6, intuitive: 2.4, easy: 1.9, easily: 1.7, simple: 1.4,
  clean: 1.6, seamless: 2.6, seamlessly: 2.4, flawless: 3.0, flawlessly: 2.9, powerful: 2.1, robust: 2.0,
  affordable: 2.0, cheap: 0.8, bargain: 2.2, value: 1.4, generous: 1.9, fair: 1.2, instant: 1.6, instantly: 1.6,
  works: 1.0, worked: 1.0, working: 0.6, fixed: 1.2, improved: 1.8, improvement: 1.5, upgrade: 0.6,
  friendly: 1.9, accurate: 1.7, precise: 1.6, secure: 1.7, safe: 1.5, satisfied: 2.2, satisfying: 2.1,
  favourite: 2.6, favorite: 2.6, essential: 1.7, gem: 2.6, delight: 2.8, delightful: 2.9, pleasant: 2.1,
  thanks: 1.6, thank: 1.6, appreciate: 1.9, wow: 2.3, cool: 1.5, elegant: 2.3, slick: 2.0, painless: 2.0,
  effortless: 2.3, crisp: 1.7, sharp: 1.2, plenty: 1.0, worthwhile: 2.1, superior: 2.2, outstanding: 3.2,
  // general negative
  bad: -2.5, terrible: -3.2, awful: -3.1, horrible: -3.2, worst: -3.2, worse: -2.2, poor: -2.2, poorly: -2.1,
  hate: -2.9, hated: -2.8, dislike: -1.9, disappointed: -2.4, disappointing: -2.4, disappointment: -2.4,
  useless: -2.7, broken: -2.6, junk: -2.8, garbage: -3.0, trash: -2.8, rubbish: -2.6, mediocre: -1.4,
  annoying: -2.1, annoyed: -2.0, frustrating: -2.4, frustrated: -2.3, confusing: -1.9, confused: -1.5,
  complicated: -1.3, clunky: -1.9, ugly: -2.1, outdated: -1.5, dated: -1.0, boring: -1.9, meh: -1.0,
  slow: -1.9, slower: -1.6, sluggish: -2.1, laggy: -2.3, lag: -1.8, lags: -1.9, stutter: -1.9, stutters: -1.9,
  freeze: -2.2, freezes: -2.3, froze: -2.2, frozen: -1.6, hang: -1.4, hangs: -1.9,
  crash: -2.6, crashes: -2.7, crashed: -2.6, crashing: -2.6, bug: -1.8, bugs: -2.0, buggy: -2.5, glitch: -1.8,
  glitches: -2.0, glitchy: -2.2, error: -1.6, errors: -1.8, fail: -2.2, fails: -2.3, failed: -2.3, failure: -2.4,
  unstable: -2.2, unreliable: -2.3, unusable: -3.0, unplayable: -2.9, bloat: -2.0, bloated: -2.1, bloatware: -2.3,
  failing: -2.2, locked: -1.2, polite: 1.0,
  expensive: -1.5, overpriced: -2.3, pricey: -1.2, ripoff: -3.0, scam: -3.2, refund: -1.4, refunded: -0.8,
  waste: -2.5, wasted: -2.4, missing: -1.1, lacks: -1.3, lacking: -1.4, limited: -1.0, problem: -1.6,
  problems: -1.8, issue: -1.2, issues: -1.5, difficult: -1.5, hard: -0.6, impossible: -2.0, nightmare: -3.0,
  unresponsive: -2.3, invalid: -1.6, rejected: -1.8, denied: -1.6, spam: -2.0, ads: -1.2, intrusive: -1.9,
  drains: -1.6, overheats: -2.1, leak: -1.7, leaks: -1.8, malware: -3.1, virus: -2.8, sad: -2.0, angry: -2.6,
  regret: -2.3, avoid: -2.2, unfortunately: -1.4, sadly: -1.4, mess: -2.0, messy: -1.7, pain: -1.9,
  painful: -2.2, ridiculous: -2.0, shame: -1.8, disaster: -3.0, pathetic: -2.8, lousy: -2.4, weak: -1.4,
  // emoticons
  ':)': 2.0, ':-)': 2.0, ':(': -2.0, ':-(': -2.0, ':d': 2.6, '<3': 2.5,
};

/** multi-word expressions, matched before single words */
export const PHRASES = {
  'waste of money': -3.0, 'waste of time': -2.8, 'worth every penny': 3.2, 'worth the money': 2.4,
  'piece of junk': -3.0, 'does the job': 1.6, 'gets the job done': 1.8, 'value for money': 2.2,
  'not bad': 1.2, 'no issues': 2.0, 'no problems': 2.0, 'no complaints': 2.2, 'no bugs': 1.8,
  'never crashes': 2.2, 'never crashed': 2.2, 'stopped working': -2.6, 'does not work': -2.6,
  "doesn't work": -2.6, "didn't work": -2.5, 'not working': -2.4, 'money back': -1.6, 'customer service': 0,
  'falls short': -1.9, 'fell short': -1.9, 'too expensive': -2.3, 'too slow': -2.4, 'game changer': 2.8,
  'must have': 2.4, 'must-have': 2.4, 'up and running': 1.8, 'out of the box': 0.8, 'hit or miss': -1.0,
  'buy again': 2.4, 'ten out of ten': 3.0, 'couldn\'t be happier': 3.0, 'could not be happier': 3.0,
  'keeps crashing': -2.8, 'keeps failing': -2.6,
};

const BOOSTERS = {
  very: 0.293, really: 0.293, extremely: 0.35, incredibly: 0.35, super: 0.293, so: 0.25, totally: 0.29,
  absolutely: 0.35, completely: 0.29, highly: 0.29, truly: 0.25, quite: 0.15, too: 0.2, insanely: 0.35,
  most: 0.2, utterly: 0.35, seriously: 0.2,
  slightly: -0.293, somewhat: -0.25, kinda: -0.25, 'kind-of': -0.25, barely: -0.35, mostly: -0.1,
  marginally: -0.3, little: -0.2, bit: -0.2, fairly: -0.1,
};

const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'neither', 'nor', 'without', 'hardly', 'cannot',
  "don't", "doesn't", "didn't", "isn't", "wasn't", "aren't", "weren't", "won't", "wouldn't", "can't",
  "couldn't", "shouldn't", "haven't", "hasn't", "hadn't", 'dont', 'doesnt', 'didnt', 'isnt', 'wasnt',
  'cant', 'wont', 'aint', "ain't",
]);
const CONTRAST = new Set(['but', 'however', 'yet', 'though']);

export const NEGATION_SCALAR = -0.74;
const CAPS_BONUS = 0.733;
const ALPHA = 15; // normalisation: compound = s / sqrt(s² + α)

/** Aspects buyers talk about in software reviews. */
export const ASPECTS = {
  price: ['price', 'priced', 'pricing', 'cost', 'costs', 'expensive', 'cheap', 'affordable', 'overpriced',
    'value', 'money', 'subscription', 'pricey', 'bargain', 'refund', 'dollars', 'penny', 'worth', 'free'],
  performance: ['fast', 'slow', 'speed', 'performance', 'lag', 'laggy', 'sluggish', 'snappy', 'responsive',
    'cpu', 'ram', 'memory', 'battery', 'fps', 'render', 'rendering', 'loads', 'loading', 'startup', 'quick',
    'bloated', 'lightweight', 'stutter', 'stutters', 'export', 'exports'],
  stability: ['crash', 'crashes', 'crashed', 'crashing', 'bug', 'bugs', 'buggy', 'freeze', 'freezes', 'froze',
    'stable', 'unstable', 'glitch', 'glitches', 'glitchy', 'reliable', 'unreliable', 'error', 'errors', 'hangs'],
  usability: ['ui', 'interface', 'intuitive', 'easy', 'confusing', 'design', 'menus', 'menu', 'layout',
    'learning', 'workflow', 'clunky', 'navigate', 'navigation', 'shortcuts', 'clean', 'simple', 'complicated'],
  activation: ['install', 'installed', 'installation', 'installer', 'activation', 'activate', 'activated',
    'key', 'licence', 'license', 'download', 'downloaded', 'setup', 'email', 'code', 'delivery', 'delivered'],
  support: ['support', 'help', 'helpful', 'response', 'responded', 'team', 'service', 'ticket', 'docs',
    'documentation', 'community', 'developer', 'developers', 'updates', 'update'],
  features: ['feature', 'features', 'tools', 'plugins', 'templates', 'effects', 'options', 'integration',
    'sync', 'cloud', 'collaboration', 'content', 'library', 'catalogue', 'catalog', 'levels', 'gameplay', 'story'],
};
export const ASPECT_NAMES = Object.keys(ASPECTS);
const ASPECT_OF = new Map();
for (const [a, words] of Object.entries(ASPECTS)) for (const w of words) ASPECT_OF.set(w, a);

const TOKEN_RE = /<3|:-?[()dp]|[a-z0-9]+(?:['’-][a-z0-9]+)*|[!?]/gi;

export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(sentence) {
  const raw = sentence.match(TOKEN_RE) || [];
  return raw.map((t) => t.replace('’', "'"));
}

/**
 * Score one sentence. Returns {score, compound, tokens[]} where each token
 * carries the rule trace used by the website: {text, base, value, negated,
 * boost, caps, contrast, phrase}.
 */
export function scoreSentence(sentence) {
  const toks = tokenize(sentence);
  const lower = toks.map((t) => t.toLowerCase());
  const mixedCase = toks.some((t) => /[a-z]/.test(t)) && toks.some((t) => /^[A-Z]{2,}$/.test(t));
  const out = [];
  let contrastAt = -1;
  for (let i = 0; i < lower.length; i++) if (CONTRAST.has(lower[i])) contrastAt = i;

  let i = 0;
  while (i < lower.length) {
    // phrases first (longest match, up to 4 words)
    let matched = null;
    for (let len = 4; len >= 2 && !matched; len--) {
      if (i + len > lower.length) continue;
      const phrase = lower.slice(i, i + len).join(' ');
      if (phrase in PHRASES) matched = { phrase, len };
    }
    if (matched) {
      const base = PHRASES[matched.phrase];
      const contrast = contrastAt < 0 ? 1 : i < contrastAt ? 0.5 : 1.5;
      const negated = isNegatedAt(lower, i);
      out.push({ text: toks.slice(i, i + matched.len).join(' '), base, value: base * contrast * (negated ? NEGATION_SCALAR : 1),
        phrase: true, negated: negated || undefined, contrast: contrast !== 1 ? contrast : undefined,
        aspect: aspectFor(lower.slice(i, i + matched.len)) });
      i += matched.len;
      continue;
    }
    const w = lower[i];
    const base = LEXICON[w];
    const tok = { text: toks[i], base: base ?? 0, value: 0 };
    if (ASPECT_OF.has(w)) tok.aspect = ASPECT_OF.get(w);
    if (base !== undefined && base !== 0) {
      let v = base;
      // boosters / dampeners in the three preceding words (decaying)
      let boost = 0;
      for (let j = 1; j <= 3 && i - j >= 0; j++) {
        const b = BOOSTERS[lower[i - j]];
        if (b !== undefined) boost += b * (j === 1 ? 1 : j === 2 ? 0.95 : 0.9) * Math.sign(v);
      }
      v += boost;
      if (mixedCase && /^[A-Z]{2,}$/.test(toks[i])) { v += Math.sign(v) * CAPS_BONUS; tok.caps = true; }
      // negation in the three preceding words flips and dampens
      const negated = isNegatedAt(lower, i);
      if (negated) v *= NEGATION_SCALAR;
      const contrast = contrastAt < 0 ? 1 : i < contrastAt ? 0.5 : i > contrastAt ? 1.5 : 1;
      v *= contrast;
      tok.value = v;
      if (boost) tok.boost = boost;
      if (negated) tok.negated = true;
      if (contrast !== 1) tok.contrast = contrast;
    }
    out.push(tok);
    i++;
  }
  let score = out.reduce((a, t) => a + t.value, 0);
  // exclamation marks amplify (up to 4)
  const bangs = Math.min(4, lower.filter((t) => t === '!').length);
  if (score && bangs) score += Math.sign(score) * bangs * 0.292;
  return { score, compound: normalise(score), tokens: out };
}

function isNegatedAt(lower, i) {
  for (let j = 1; j <= 3 && i - j >= 0; j++) {
    if (NEGATIONS.has(lower[i - j]) || lower[i - j].endsWith("n't")) return true;
  }
  return false;
}

function aspectFor(words) {
  for (const w of words) if (ASPECT_OF.has(w)) return ASPECT_OF.get(w);
  return undefined;
}

export const normalise = (s) => s / Math.sqrt(s * s + ALPHA);

export const labelOf = (compound) => (compound >= 0.05 ? 'positive' : compound <= -0.05 ? 'negative' : 'neutral');

/**
 * Analyse a whole review: overall compound, label, per-aspect scores, and the
 * sentence breakdown.
 */
export function analyseReview(text) {
  const sentences = splitSentences(text).map((s) => ({ text: s, ...scoreSentence(s) }));
  const total = sentences.reduce((a, s) => a + s.score, 0);
  const compound = normalise(total);
  const aspects = {};
  for (const s of sentences) {
    const found = new Set(s.tokens.map((t) => t.aspect).filter(Boolean));
    for (const a of found) {
      (aspects[a] ||= { n: 0, sum: 0 });
      aspects[a].n += 1;
      aspects[a].sum += s.compound;
    }
  }
  const aspectScores = Object.fromEntries(
    Object.entries(aspects).map(([a, { n, sum }]) => [a, round3(sum / n)]),
  );
  return { compound: round3(compound), label: labelOf(compound), aspects: aspectScores, sentences };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Stars and words disagree strongly → flag for the provider. */
export function isMismatch(stars, compound) {
  return (stars >= 4 && compound <= -0.3) || (stars <= 2 && compound >= 0.3);
}

const ASPECT_LABEL = {
  price: 'price', performance: 'performance', stability: 'stability', usability: 'ease of use',
  activation: 'installation and activation', support: 'support and updates', features: 'features',
};

/**
 * Turn stored aggregates + recent reviews into the "What buyers say" panel.
 * `agg` is the counters kept on the product item; `recent` the latest reviews.
 */
export function summarise(agg, recent = []) {
  const n = agg.reviewCount || 0;
  if (!n) return { reviews: 0, headline: 'No reviews yet.', aspects: [], highlights: {} };
  const pos = agg.pos || 0, neg = agg.neg || 0, neu = n - pos - neg;
  const share = (x) => Math.round((100 * x) / n);
  const mood = pos / n >= 0.75 ? 'very positive' : pos / n >= 0.55 ? 'mostly positive'
    : neg / n >= 0.55 ? 'mostly negative' : neg / n >= 0.35 ? 'divided' : 'mixed';
  const aspects = ASPECT_NAMES
    .map((a) => ({ aspect: a, label: ASPECT_LABEL[a], mentions: agg[`a_${a}_n`] || 0,
      score: agg[`a_${a}_n`] ? round3((agg[`a_${a}_s`] || 0) / 1000 / agg[`a_${a}_n`]) : 0 }))
    .filter((a) => a.mentions > 0)
    .sort((x, y) => y.mentions - x.mentions);
  const praised = aspects.filter((a) => a.score >= 0.2).slice(0, 2).map((a) => a.label);
  const criticised = aspects.filter((a) => a.score <= -0.2).sort((x, y) => x.score - y.score)[0];
  let headline = `Buyers are ${mood} (${share(pos)} % positive, ${share(neg)} % negative across ${n} review${n > 1 ? 's' : ''}).`;
  if (praised.length) headline += ` They praise ${praised.join(' and ')}`;
  if (criticised) headline += `${praised.length ? ';' : ' The'} most common complaint is ${criticised.label}`;
  if (praised.length || criticised) headline += '.';

  // highlights: the most positive / most negative short sentence from recent reviews
  let best = null, worst = null;
  for (const r of recent) {
    for (const s of splitSentences(r.text)) {
      if (s.length < 12 || s.length > 160) continue;
      const c = scoreSentence(s).compound;
      if (!best || c > best.compound) best = { text: s, compound: round3(c), reviewId: r.reviewId };
      if (!worst || c < worst.compound) worst = { text: s, compound: round3(c), reviewId: r.reviewId };
    }
  }
  return {
    reviews: n,
    averageStars: Math.round(((agg.ratingSum || 0) / n) * 10) / 10,
    sentiment: round3((agg.sentSum || 0) / 1000 / n),
    split: { positive: pos, neutral: neu, negative: neg },
    mood,
    headline,
    aspects,
    highlights: {
      praise: best && best.compound >= 0.3 ? best : null,
      complaint: worst && worst.compound <= -0.3 ? worst : null,
    },
    mismatches: agg.mismatch || 0,
  };
}

/**
 * Counter deltas a review contributes to the product aggregates (all integers,
 * so they can be applied with DynamoDB ADD and reversed exactly on edit).
 */
export function reviewDeltas(stars, analysis, sign = 1) {
  const d = {
    reviewCount: sign, ratingSum: sign * stars, sentSum: sign * Math.round(analysis.compound * 1000),
    pos: analysis.label === 'positive' ? sign : 0, neg: analysis.label === 'negative' ? sign : 0,
    mismatch: isMismatch(stars, analysis.compound) ? sign : 0,
  };
  for (const [a, s] of Object.entries(analysis.aspects)) {
    d[`a_${a}_n`] = sign;
    d[`a_${a}_s`] = sign * Math.round(s * 1000);
  }
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== 0));
}
