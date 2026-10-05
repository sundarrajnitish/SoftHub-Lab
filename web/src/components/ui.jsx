import { Link } from 'react-router-dom';
import { money } from '../lib/backend.js';

const GLYPHS = [
  'M8 20 L16 6 L24 20 Z', 'M6 13 h20 v6 h-20 Z', 'M16 5 a11 11 0 1 0 0.01 0 Z', 'M7 7 h18 v18 h-18 Z M12 12 h8 v8 h-8 Z',
  'M5 22 L12 10 L17 17 L21 12 L27 22 Z', 'M16 5 L27 16 L16 27 L5 16 Z', 'M6 9 h20 M6 16 h20 M6 23 h20', 'M9 6 v20 M16 6 v20 M23 6 v20',
];

/** Generated product artwork (no stock images or logos). */
export function ProductArt({ image, name, size = 'md' }) {
  const img = image || { hue: 20, hue2: 200, glyph: 0, monogram: (name || '?').slice(0, 2).toUpperCase() };
  const id = `g${img.hue}-${img.hue2}-${img.glyph}`;
  return (
    <svg className={`art art-${size}`} viewBox="0 0 32 32" role="img" aria-label={name}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${img.hue} 70% 52%)`} />
          <stop offset="1" stopColor={`hsl(${img.hue2} 65% 32%)`} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="6" fill={`url(#${id})`} />
      <path d={GLYPHS[img.glyph % GLYPHS.length]} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="1.4" />
      <text x="16" y="19.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">{img.monogram}</text>
    </svg>
  );
}

export function Stars({ value, count }) {
  if (value === null || value === undefined) return <span className="muted small">No ratings yet</span>;
  const full = Math.round(value);
  return (
    <span className="stars" aria-label={`${value} out of 5`}>
      <span aria-hidden>{'★'.repeat(full)}<span className="dim">{'★'.repeat(5 - full)}</span></span>
      <span className="small muted"> {value.toFixed(1)}{count !== undefined ? ` (${count})` : ''}</span>
    </span>
  );
}

export function ProductCard({ p, reason }) {
  return (
    <Link to={`/products/${p.productId}`} className="card product-card">
      <ProductArt image={p.image} name={p.name} />
      <div className="pc-body">
        <h3>{p.name}</h3>
        <p className="muted small">{p.developer}</p>
        <Stars value={p.rating} count={p.reviewCount} />
        {reason && <p className="reason small">{reason}</p>}
      </div>
      <strong className="price">{money(p.priceCents)}</strong>
    </Link>
  );
}

export const Spinner = () => <div className="spinner" role="status" aria-label="Loading" />;

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      {error.message}
      {error.fields && <ul>{error.fields.map((f) => <li key={f.field}>{f.field}: {f.error}</li>)}</ul>}
    </div>
  );
}

export function Loadable({ state, children }) {
  if (state.loading && !state.data) return <Spinner />;
  if (state.error) return <ErrorBox error={state.error} />;
  return children(state.data);
}

export function Bars({ series, value, label, height = 140 }) {
  const max = Math.max(1, ...series.map(value));
  const w = 100 / series.length;
  return (
    <svg className="bars" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label="chart">
      {series.map((d, i) => {
        const h = (value(d) / max) * (height - 16);
        return (
          <rect key={i} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} rx="0.6">
            <title>{label(d)}</title>
          </rect>
        );
      })}
    </svg>
  );
}
