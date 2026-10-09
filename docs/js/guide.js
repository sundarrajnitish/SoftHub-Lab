// The demo guide: a short journey through SoftHub that ticks itself off.
import { h, $, mount } from './ui.js';
import { accountModal, inboxModal } from './shop.js';

const STEPS = [
  { id: 'browse', title: 'Find something', hint: 'Search or open a category', go: (app) => app.go('catalog') },
  { id: 'product', title: 'See what buyers say', hint: 'Open any product page', go: (app) => app.go('catalog', { sort: 'popular' }) },
  { id: 'paid', title: 'Buy it as Maya', hint: 'Checkout with a test card', go: async (app) => { if (app.role() !== 'Consumer') await app.setPersona('buyer'); app.go('home'); } },
  { id: 'inbox', title: 'Get your licence key', hint: 'It arrives in the inbox', go: (app) => inboxModal(app) },
  { id: 'review', title: 'Review what you bought', hint: 'Watch it read your tone', go: async (app) => { if (app.role() !== 'Consumer') await app.setPersona('buyer'); app.go('mine'); } },
  { id: 'listing', title: 'Publish your own product', hint: 'As Northlight Software', go: async (app) => { if (app.role() !== 'Provider') await app.setPersona('provider'); app.go('listing'); } },
  { id: 'scenes', title: 'Look behind the scenes', hint: 'See each click travel', go: (app) => app.emit('open-scenes') },
];

export function initGuide(app) {
  const done = new Set();
  let min = true; // starts as a small pill; the hero's "Take the tour" opens it
  let userSet = false; // once the visitor opens or closes it, leave it as they chose
  try {
    const v = localStorage.getItem('softhub.guide.min');
    if (v !== null) { min = v === '1'; userSet = true; }
  } catch { /* storage unavailable */ }
  const el = $('#guide');
  const draw = () => {
    const n = done.size, total = STEPS.length;
    const c = 2 * Math.PI * 10;
    el.classList.toggle('min', min);
    mount(el,
      h('button', { type: 'button', class: 'guide-head', 'aria-expanded': String(!min), onclick: () => { min = !min; userSet = true; try { localStorage.setItem('softhub.guide.min', min ? '1' : '0'); } catch { /* ignore */ } draw(); } },
        h('svg', { svg: true, class: 'ring', viewBox: '0 0 26 26', 'aria-hidden': 'true' },
          h('circle', { svg: true, class: 'bg', cx: 13, cy: 13, r: 10 }),
          h('circle', { svg: true, class: 'fg', cx: 13, cy: 13, r: 10, 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - n / total), transform: 'rotate(-90 13 13)' })),
        h('span', {}, h('b', {}, n === total ? 'You’ve seen it all' : 'Take the tour'), h('br'), h('span', { class: 'small muted' }, n === total ? 'Thanks for trying SoftHub' : 'Seven steps through SoftHub')),
        h('span', { class: 'prog' }, `${n}/${total}`)),
      h('ol', {}, STEPS.map((s) => h('li', { class: done.has(s.id) ? 'done' : '' },
        h('button', { type: 'button', onclick: () => { if (!app.ready) return; min = true; draw(); s.go(app); } },
          h('span', { class: 'tick' }, '✓'), h('span', {}, h('span', { class: 't' }, s.title), h('span', { class: 'h' }, s.hint)))))));
  };
  app.on('did', (id) => { if (!done.has(id) && STEPS.some((s) => s.id === id)) { done.add(id); draw(); } });
  // tuck the guide away once the visitor starts exploring, so it never covers the page
  app.on('view', (v) => { if (!userSet && !min && v.name !== 'home') { min = true; draw(); } });
  app.on('open-guide', () => { min = false; draw(); });
  draw();
  return { accountModal };
}
