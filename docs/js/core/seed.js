// Copied from packages/core/src by scripts/build-site.mjs — edit the original.
// Demo marketplace: a fictional catalogue, providers, accounts, and a
// reproducible purchase/review history generated through the real API.
// Every product, studio and person here is invented; artwork is generated.

export const STUDIOS = [
  { key: 'northlight', name: 'Northlight Software', email: 'studio@northlight.example' },
  { key: 'tidepool', name: 'Tidepool Labs', email: 'hello@tidepool.example' },
  { key: 'emberfox', name: 'Emberfox Games', email: 'dev@emberfox.example' },
  { key: 'quietcraft', name: 'Quietcraft', email: 'team@quietcraft.example' },
  { key: 'parallax', name: 'Parallax Media', email: 'sales@parallax.example' },
  { key: 'bastion', name: 'Bastion Security', email: 'ops@bastion.example' },
];

// q = latent quality (mean stars), asp = how each aspect tends to be judged (−1..1)
export const CATALOGUE = [
  // productivity
  { name: 'Tessera Office Suite', category: 'productivity', studio: 'northlight', price: 8900, tags: ['office', 'documents', 'spreadsheets', 'offline'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 4.3, asp: { price: 0.4, usability: 0.6, stability: 0.5, features: 0.6 }, desc: 'Word processor, spreadsheets and slides that open every common format, work fully offline and sync when you want them to.', features: ['Track changes and comments', 'Pivot tables', 'PDF export', 'Offline first'] },
  { name: 'Quillwork Notes', category: 'productivity', studio: 'quietcraft', price: 2900, tags: ['notes', 'markdown', 'sync', 'writing'], platforms: ['Windows', 'macOS', 'iOS', 'Android'], license: 'Perpetual', q: 4.5, asp: { usability: 0.8, performance: 0.6, features: 0.3, price: 0.5 }, desc: 'A fast Markdown notebook with backlinks, daily notes and end-to-end encrypted sync across your devices.', features: ['Backlinks and graph view', 'Encrypted sync', 'Templates', 'Instant search'] },
  { name: 'Ledgerline Sheets', category: 'productivity', studio: 'northlight', price: 4900, tags: ['spreadsheets', 'finance', 'charts', 'office'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 3.6, asp: { features: 0.6, performance: -0.5, usability: -0.2, price: 0.1 }, desc: 'A spreadsheet built for budgets and small-business books, with bank-statement import and live charts.', features: ['Statement import', 'Live charts', 'Budget templates', '200+ functions'] },
  { name: 'Plotboard Planner', category: 'productivity', studio: 'quietcraft', price: 3900, tags: ['planning', 'kanban', 'calendar', 'team'], platforms: ['Web', 'Windows', 'macOS'], license: 'Subscription (1 year)', q: 3.9, asp: { usability: 0.5, support: 0.4, price: -0.4, features: 0.4 }, desc: 'Boards, timelines and a shared calendar for small teams, with recurring tasks and gentle reminders.', features: ['Kanban and timeline views', 'Recurring tasks', 'Calendar sync', 'Guest access'] },
  { name: 'Folio PDF Studio', category: 'productivity', studio: 'northlight', price: 5900, tags: ['pdf', 'documents', 'ocr', 'signing'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 4.0, asp: { features: 0.7, price: -0.3, stability: 0.3, activation: -0.2 }, desc: 'Edit, annotate, sign and OCR PDFs; merge and compress files in batches.', features: ['OCR in 20 languages', 'Digital signatures', 'Batch compress', 'Form editing'] },
  // video editors
  { name: 'Lumen Cut Pro', category: 'video-editors', studio: 'parallax', price: 19900, tags: ['video', 'editing', '4k', 'color-grading'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 4.4, asp: { features: 0.8, performance: 0.4, price: -0.3, stability: 0.3 }, desc: 'A professional non-linear editor with multicam, proxy workflows and a node-based colour page.', features: ['Multicam editing', 'Proxy media', 'Node colour grading', 'HDR export'] },
  { name: 'Reelsmith Express', category: 'video-editors', studio: 'parallax', price: 4900, tags: ['video', 'editing', 'beginner', 'templates'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 4.1, asp: { usability: 0.8, price: 0.6, performance: 0.1, features: -0.2 }, desc: 'Quick edits for social video: drag-and-drop timeline, auto captions and a library of templates.', features: ['Auto captions', 'Vertical templates', 'One-click export', 'Royalty-free music'] },
  { name: 'Grainfield Color', category: 'video-editors', studio: 'tidepool', price: 12900, tags: ['color-grading', 'video', 'luts', '4k'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.2, asp: { features: 0.7, performance: 0.5, usability: -0.3, price: 0.0 }, desc: 'Scopes, film emulation and LUT management for colourists, as a standalone app or editor plug-in.', features: ['Waveform and vectorscope', 'Film emulation', 'LUT manager', 'GPU accelerated'] },
  { name: 'Kinetype Motion', category: 'video-editors', studio: 'tidepool', price: 8900, tags: ['motion-graphics', 'titles', 'animation', 'video'], platforms: ['Windows', 'macOS'], license: 'Subscription (1 year)', q: 3.4, asp: { features: 0.6, stability: -0.7, performance: -0.4, price: -0.3 }, desc: 'Animated titles and lower thirds with keyframe curves, text-on-path and template packs.', features: ['Keyframe curves', 'Text on path', 'Template packs', 'Alpha export'] },
  { name: 'Framewise 4K', category: 'video-editors', studio: 'parallax', price: 2900, tags: ['video', 'converter', '4k', 'compression'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 3.8, asp: { performance: 0.6, price: 0.6, usability: -0.1, features: -0.3 }, desc: 'Convert, trim and compress video with hardware encoders and smart presets for every platform.', features: ['Hardware encoding', 'Batch queue', 'Smart presets', 'Lossless trim'] },
  // games
  { name: 'Ashen Lanterns', category: 'games', studio: 'emberfox', price: 2499, tags: ['roguelike', 'action', 'indie', 'single-player'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.6, asp: { features: 0.8, performance: 0.5, stability: 0.4, price: 0.7 }, desc: 'A hand-drawn roguelike about carrying light through a drowned city. Every run rewrites the map.', features: ['Procedural districts', '40+ relics', 'Daily challenge', 'Controller support'] },
  { name: 'Harbor Tycoon', category: 'games', studio: 'emberfox', price: 2999, tags: ['simulation', 'strategy', 'management', 'single-player'], platforms: ['Windows', 'macOS'], license: 'Perpetual', q: 3.7, asp: { features: 0.5, performance: -0.5, stability: -0.3, price: 0.2 }, desc: 'Build a port from one pier to a global shipping hub; balance cranes, contracts and the weather.', features: ['Sandbox mode', 'Dynamic economy', 'Weather systems', 'Mod support'] },
  { name: 'Skyward Relay', category: 'games', studio: 'emberfox', price: 1999, tags: ['racing', 'multiplayer', 'arcade', 'online'], platforms: ['Windows'], license: 'Perpetual', q: 3.2, asp: { features: 0.2, stability: -0.6, performance: -0.4, support: -0.4 }, desc: 'Arcade air racing through floating cities with eight-player online lobbies.', features: ['8-player online', 'Track editor', 'Seasonal events', 'Split screen'] },
  { name: 'Glasswing', category: 'games', studio: 'quietcraft', price: 1499, tags: ['puzzle', 'indie', 'relaxing', 'single-player'], platforms: ['Windows', 'macOS', 'iOS'], license: 'Perpetual', q: 4.7, asp: { features: 0.7, usability: 0.7, price: 0.8, performance: 0.6 }, desc: 'A calm puzzle game about light, mirrors and stained glass, with 120 hand-made levels.', features: ['120 levels', 'Level editor', 'No timers', 'Colour-blind palettes'] },
  { name: 'Ironroot Tactics', category: 'games', studio: 'emberfox', price: 3499, tags: ['strategy', 'turn-based', 'tactics', 'single-player'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.2, asp: { features: 0.7, performance: 0.2, usability: -0.2, price: 0.3 }, desc: 'Turn-based tactics in a living forest; command a squad of wardens through a branching campaign.', features: ['Branching campaign', 'Permadeath mode', 'Skirmish maps', 'Mod tools'] },
  // streaming services
  { name: 'Cadence Music+ (1 year)', category: 'streaming-services', studio: 'parallax', price: 11900, tags: ['music', 'streaming', 'lossless', 'subscription'], platforms: ['Web', 'iOS', 'Android', 'Windows', 'macOS'], license: 'Subscription (1 year)', q: 4.1, asp: { features: 0.6, price: 0.2, performance: 0.3, activation: 0.2 }, desc: 'Ad-free lossless music streaming with offline downloads and spatial audio, billed once a year.', features: ['Lossless audio', 'Offline downloads', 'Spatial audio', 'Family sharing'] },
  { name: 'Nightreel Films (1 year)', category: 'streaming-services', studio: 'parallax', price: 9900, tags: ['film', 'streaming', 'subscription', '4k'], platforms: ['Web', 'iOS', 'Android'], license: 'Subscription (1 year)', q: 3.5, asp: { features: -0.3, price: -0.2, performance: 0.2, activation: -0.4 }, desc: 'Independent and classic cinema in 4K, curated weekly, with director commentaries.', features: ['Weekly curation', '4K HDR', 'Director commentaries', 'Download to watch'] },
  { name: 'Lectern Learning (1 year)', category: 'streaming-services', studio: 'tidepool', price: 14900, tags: ['learning', 'courses', 'subscription', 'certificates'], platforms: ['Web', 'iOS', 'Android'], license: 'Subscription (1 year)', q: 4.3, asp: { features: 0.7, support: 0.5, price: -0.1, usability: 0.4 }, desc: 'Courses in software, design and data with exercises, mentors and shareable certificates.', features: ['600+ courses', 'Hands-on labs', 'Mentor sessions', 'Certificates'] },
  { name: 'Podwave Premium (1 year)', category: 'streaming-services', studio: 'quietcraft', price: 4900, tags: ['podcasts', 'audio', 'subscription', 'offline'], platforms: ['iOS', 'Android', 'Web'], license: 'Subscription (1 year)', q: 3.9, asp: { usability: 0.5, features: 0.3, price: 0.3, stability: -0.2 }, desc: 'Ad-free podcasts, chapter search, smart speed and transcripts for every episode.', features: ['Transcripts', 'Smart speed', 'Chapter search', 'Ad-free'] },
  // developer tools
  { name: 'Tidewater IDE', category: 'developer-tools', studio: 'tidepool', price: 9900, tags: ['ide', 'editor', 'debugger', 'refactoring'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Subscription (1 year)', q: 4.4, asp: { features: 0.8, performance: -0.2, usability: 0.4, price: -0.2 }, desc: 'A polyglot IDE with deep refactoring, a time-travel debugger and remote development.', features: ['Time-travel debugger', 'Safe refactoring', 'Remote dev', '40 languages'] },
  { name: 'Querybird DB Client', category: 'developer-tools', studio: 'tidepool', price: 6900, tags: ['database', 'sql', 'editor', 'data'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.2, asp: { features: 0.6, performance: 0.5, usability: 0.4, price: 0.2 }, desc: 'One client for PostgreSQL, MySQL, SQLite and DynamoDB-compatible stores, with visual explain plans.', features: ['Visual explain', 'Schema diff', 'Data editor', 'SSH tunnels'] },
  { name: 'Relay API Workbench', category: 'developer-tools', studio: 'northlight', price: 4900, tags: ['api', 'http', 'testing', 'team'], platforms: ['Windows', 'macOS', 'Linux', 'Web'], license: 'Subscription (1 year)', q: 3.8, asp: { features: 0.5, performance: -0.3, usability: 0.2, price: -0.3 }, desc: 'Design, test and mock HTTP and WebSocket APIs; share collections with your team.', features: ['Mock servers', 'Contract tests', 'Team workspaces', 'CLI runner'] },
  { name: 'Shellcraft Terminal', category: 'developer-tools', studio: 'quietcraft', price: 1900, tags: ['terminal', 'shell', 'productivity', 'editor'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.6, asp: { performance: 0.8, usability: 0.5, price: 0.7, stability: 0.5 }, desc: 'A GPU-rendered terminal with split panes, command palette and shareable profiles.', features: ['GPU rendering', 'Split panes', 'Command palette', 'Profiles'] },
  // security
  { name: 'Vaultline Passwords', category: 'security', studio: 'bastion', price: 3600, tags: ['passwords', 'encryption', 'sync', 'privacy'], platforms: ['Windows', 'macOS', 'iOS', 'Android', 'Web'], license: 'Subscription (1 year)', q: 4.5, asp: { usability: 0.6, features: 0.5, stability: 0.5, support: 0.4 }, desc: 'Zero-knowledge password manager with passkeys, breach alerts and family vaults.', features: ['Passkeys', 'Breach alerts', 'Family vaults', 'Emergency access'] },
  { name: 'Burrow VPN (1 year)', category: 'security', studio: 'bastion', price: 5900, tags: ['vpn', 'privacy', 'subscription', 'network'], platforms: ['Windows', 'macOS', 'iOS', 'Android', 'Linux'], license: 'Subscription (1 year)', q: 3.6, asp: { performance: -0.4, price: 0.3, stability: -0.3, support: -0.2 }, desc: 'WireGuard-based VPN with servers in 40 countries, a kill switch and an audited no-logs policy.', features: ['WireGuard', 'Kill switch', '40 countries', 'Split tunnelling'] },
  { name: 'Cairn Backup', category: 'security', studio: 'bastion', price: 4900, tags: ['backup', 'encryption', 'cloud', 'privacy'], platforms: ['Windows', 'macOS', 'Linux'], license: 'Perpetual', q: 4.0, asp: { stability: 0.5, features: 0.3, usability: -0.2, activation: -0.3 }, desc: 'Versioned, encrypted backups to any S3-compatible storage or a local drive, with one-click restore.', features: ['Client-side encryption', 'Versioning', 'S3-compatible targets', 'Restore preview'] },
  { name: 'Watchpost Antivirus', category: 'security', studio: 'bastion', price: 3900, tags: ['antivirus', 'malware', 'privacy', 'protection'], platforms: ['Windows', 'macOS'], license: 'Subscription (1 year)', q: 3.3, asp: { performance: -0.6, features: 0.2, price: -0.2, usability: -0.3 }, desc: 'Real-time malware protection with ransomware shields and a quiet gaming mode.', features: ['Real-time scanning', 'Ransomware shield', 'Gaming mode', 'Web protection'] },
];

export const DEMO_ACCOUNTS = {
  consumer: { email: 'maya.chen@example.com', password: 'Demo-buyer-1', group: 'Consumer' },
  provider: { email: STUDIOS[0].email, password: 'Demo-studio-1', group: 'Provider' },
  admin: { email: 'admin@softhub.example', password: 'Demo-admin-1', group: 'Admin' },
};

const FIRST = ['amir', 'sofia', 'liam', 'noor', 'chloe', 'mateo', 'aisha', 'ethan', 'priya', 'lucas', 'hana', 'oliver', 'zara', 'felix', 'ines', 'kai', 'leah', 'omar', 'rosa', 'theo', 'yuki', 'ben', 'mila', 'ravi', 'elena', 'sam', 'lea', 'jonah', 'ana', 'victor'];
const LAST = ['tremblay', 'gagnon', 'roy', 'nguyen', 'singh', 'martin', 'cote', 'bouchard', 'patel', 'wong', 'lavoie', 'fortin', 'ali', 'kim', 'morin', 'leblanc', 'garcia', 'chen', 'pelletier', 'okafor'];

// ----------------------------------------------------------- review text

const T = {
  general: {
    pos: ['Exactly what I needed.', 'Really happy with this purchase.', 'Would recommend it to anyone.', 'Easily one of the best tools I own.', 'Great value and it just works.', 'I use it every day now.'],
    neg: ['Honestly disappointed overall.', 'Not what I expected at all.', 'I regret buying it.', 'Hard to recommend in its current state.', 'Feels unfinished.', 'I would avoid this one for now.'],
  },
  price: {
    pos: ['Worth every penny.', 'Fair price for what you get.', 'Great value compared to the alternatives.', 'Affordable, and no subscription surprises.'],
    neg: ['Too expensive for what it does.', 'Overpriced compared to similar apps.', 'The price is hard to justify.', 'Not worth the money right now.'],
  },
  performance: {
    pos: ['It is fast and responsive even on my old laptop.', 'Starts quickly and never feels sluggish.', 'Rendering is snappy.', 'Lightweight and quick.'],
    neg: ['It is really slow on large projects.', 'The app feels sluggish and laggy.', 'Startup takes forever and exports are slow.', 'Performance drops badly after an hour.'],
  },
  stability: {
    pos: ['Rock solid, it never crashes.', 'Stable and reliable after months of use.', 'No bugs that I have noticed.', 'Very reliable.'],
    neg: ['It crashes at least once a day.', 'Buggy, and I lost work when it froze.', 'Constant glitches since the last update.', 'Unstable and frustrating.'],
  },
  usability: {
    pos: ['The interface is clean and intuitive.', 'Easy to learn, even for beginners.', 'Menus are simple and well designed.', 'The workflow feels effortless.'],
    neg: ['The interface is confusing.', 'The menus are clunky and hard to navigate.', 'Steep learning curve and a cluttered layout.', 'Simple things take too many clicks.'],
  },
  activation: {
    pos: ['The licence key arrived instantly and activation was painless.', 'Download and install took two minutes.', 'Setup was seamless.'],
    neg: ['Activation failed twice before the key worked.', 'The installer is bloated and setup was a pain.', 'Download kept failing.'],
  },
  support: {
    pos: ['Support answered within a day and was helpful.', 'The developers ship useful updates often.', 'Great documentation and a helpful community.'],
    neg: ['Support never answered my ticket.', 'Updates are rare and the docs are outdated.', 'The developer ignores bug reports.'],
  },
  features: {
    pos: ['Packed with useful features.', 'The tools are powerful and well thought out.', 'Lots of great content.'],
    neg: ['Missing basic features.', 'The feature set is limited.', 'Content is thin for the price.'],
  },
};

function polarityFor(stars, aspectBias, rng) {
  // aspect opinion follows the overall rating, nudged by the product's aspect bias
  const x = (stars - 3) / 2 + aspectBias * 0.8 + rng.normal(0, 0.35);
  return x >= 0 ? 'pos' : 'neg';
}

export function generateReview(product, rng) {
  let stars = Math.round(product.q + rng.normal(0, 0.95));
  stars = Math.min(5, Math.max(1, stars));
  const aspects = Object.keys(product.asp);
  const n = rng.weighted([[1, 3], [2, 4], [3, 2]]);
  const chosen = [];
  while (chosen.length < Math.min(n, aspects.length)) {
    const a = rng.weighted(aspects.map((x) => [x, 1 + Math.abs(product.asp[x])]));
    if (!chosen.includes(a)) chosen.push(a);
  }
  const parts = [];
  if (rng.chance(0.6)) parts.push(rng.pick(T.general[stars >= 3 ? 'pos' : 'neg']));
  for (const a of chosen) parts.push(rng.pick(T[a][polarityFor(stars, product.asp[a], rng)]));
  // a few careless ratings: the stars contradict the words
  if (rng.chance(0.01)) stars = stars >= 3 ? 1 : 5;
  return { stars, text: parts.join(' ') };
}

export const randomPerson = (rng, i) => `${rng.pick(FIRST)}.${rng.pick(LAST)}${i}@example.com`;
