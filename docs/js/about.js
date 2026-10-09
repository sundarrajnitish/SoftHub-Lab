// "How it works": the idea, the payment path, the building blocks, and what was verified.
import { h, int, chip } from './ui.js';
import { drawDiagram } from './diagram.js';
import { RESULTS } from '../data/results.js';

export function page(app) {
  const R = RESULTS;
  const arch = h('svg', { svg: true, viewBox: '0 0 640 380', role: 'img', 'aria-label': 'SoftHub architecture' });
  drawDiagram(arch);
  const deliveries = R.chaos.reduce((a, c) => a + c.deliveries, 0);
  const dupes = R.chaos.reduce((a, c) => a + c.duplicatesAbsorbed, 0);
  const retries = R.chaos.reduce((a, c) => a + c.failedAttempts, 0);
  const tryIt = h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => app.setPersona('buyer').then(() => app.go('home')) }, 'Shop as Maya'),
    h('button', { type: 'button', class: 'btn', onclick: () => app.setPersona('provider') }, 'Open a studio'),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => app.emit('open-scenes') }, 'Watch behind the scenes'));
  return h('div', { class: 'about' },
    h('section', { class: 'about-hero' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'About the project'),
        h('h1', {}, 'All your software in one store, with the key in your inbox seconds after you pay.'),
        h('p', {}, 'Buying software usually means a different website, account and checkout for every vendor, then waiting for a key. SoftHub puts independent studios side by side: buyers pay once by card and get licence keys by e-mail and installers in a personal library; studios list products in a minute and see sales and what buyers say; an admin runs the platform.'),
        h('p', {}, 'Everything on this page is the real application. The same code that runs on AWS Lambda runs in your browser here, against stand-ins for the managed services, so you can use every part of it without an account or a card.'),
        h('div', { style: { marginTop: '20px' } }, tryIt)),
      h('div', { class: 'archbox' }, arch)),

    h('section', {},
      h('div', { class: 'section-head' }, h('h2', {}, 'What happens when you press Pay')),
      h('div', { class: 'flow-steps' },
        h('div', {}, h('b', {}, 'The server prices your cart'), h('p', {}, 'Prices come from the catalogue, never from the browser. A pending order and a Stripe PaymentIntent are created together; pressing twice gives you the same order.')),
        h('div', {}, h('b', {}, 'Your bank approves the card'), h('p', {}, 'The card goes straight to Stripe, including any 3-D Secure check. SoftHub never sees the number.')),
        h('div', {}, h('b', {}, 'Stripe tells SoftHub'), h('p', {}, 'A signed webhook arrives. Its signature and timestamp are checked before anything else happens.')),
        h('div', {}, h('b', {}, 'One transaction issues the keys'), h('p', {}, 'Order status, licence keys, ownership, cart, sales ledger and the receipt are written together or not at all, and the event is recorded so a repeat changes nothing.')),
        h('div', {}, h('b', {}, 'The receipt is e-mailed'), h('p', {}, 'The database change stream picks up the receipt and sends it through SES, with retries if mail is slow.')))),

    h('section', { class: 'pillars' },
      h('div', { class: 'pillar' }, h('h3', {}, 'Keys you can count on'), h('p', {}, 'Each licence key is derived from the order, the product and the buyer, so it is unique, cannot be forged, and is the same however many times the payment notice arrives. A built-in checksum catches typos before the key is ever sent to a server.')),
      h('div', { class: 'pillar' }, h('h3', {}, 'Small managed parts'), h('p', {}, 'API Gateway checks every sign-in token before code runs. Separate Lambda functions keep public browsing apart from checkout and fulfilment. One DynamoDB table answers every page with a single lookup. Nothing runs, or costs, while nobody is shopping.')),
      h('div', { class: 'pillar' }, h('h3', {}, 'Listens to buyers'), h('p', {}, 'Every review is read for tone and for what it talks about, so a product page can say what buyers praise and what they complain about. Recommendations combine what listings have in common with what owners actually bought together.'))),

    h('section', {},
      h('div', { class: 'section-head' }, h('h2', {}, 'Verified'), h('span', { class: 'small muted' }, 'by the automated tests and the simulator in the repository')),
      h('div', { class: 'verified' },
        h('div', { class: 'kpi' }, h('b', {}, int(deliveries)), h('span', {}, `payment notices handled in simulated runs, including ${int(dupes)} repeats and ${int(retries)} retries, with every order fulfilled exactly once`)),
        h('div', { class: 'kpi' }, h('b', {}, `${R.chaos[0].checks}`), h('span', {}, 'audit checks recount every key, counter, charge and e-mail after each run, and all of them pass')),
        h('div', { class: 'kpi' }, h('b', {}, int(R.launchDay.requests)), h('span', {}, `requests served in a simulated launch day, ${int(R.launchDay.orders)} orders paid and delivered`)),
        h('div', { class: 'kpi' }, h('b', {}, '48'), h('span', {}, 'automated tests, from cryptography and the table design to complete purchases')))),

    h('section', {},
      h('div', { class: 'section-head' }, h('h2', {}, 'Built with')),
      h('div', { class: 'stack-chips' }, ['AWS Lambda · Node.js 24 · arm64', 'API Gateway HTTP API + JWT authorizer', 'DynamoDB single table + streams', 'Cognito user pool & groups', 'Stripe PaymentIntents & webhooks', 'SES', 'S3 presigned URLs', 'AWS SAM', 'React + Vite', 'node:test'].map((t) => chip(t, 'flow')))),

    h('section', { class: 'sell' },
      h('div', {}, h('h2', {}, 'Try the whole journey'), h('p', {}, 'Buy something as Maya and watch the key arrive in the inbox, post a review, then switch to the studio to publish a product of your own. Open “Behind the scenes” at any point to see each step travel through the system.')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => app.setPersona('buyer').then(() => app.go('home')) }, 'Start as Maya')),

    h('p', { class: 'small muted' }, 'Designed and built by Nitish Sundarraj. Every studio, product and person in the demo is fictional; product art is generated from names. ', h('a', { href: 'https://github.com/sundarrajnitish/SoftHub-Lab' }, 'Source code on GitHub'), '.'));
}
