import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useBackend } from '../lib/context.jsx';
import { money } from '../lib/backend.js';
import { ProductArt, Loadable, ErrorBox, Bars, Stars } from '../components/ui.jsx';
import { CATEGORIES } from '@core/keys.js';

const PLATFORMS = ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Web'];
const LICENSES = ['Perpetual', 'Subscription (1 year)', 'Subscription (1 month)', 'Freemium'];

export function Dashboard() {
  const dash = useApi('/provider/dashboard');
  return (
    <section>
      <div className="row between"><h1>Sales</h1><Link className="btn primary" to="/provider/new">New listing</Link></div>
      <Loadable state={dash}>{(d) => (
        <>
          <div className="kpis">
            <div className="card kpi"><span className="muted small">Revenue, 30 days</span><strong>{money(d.totals.revenueCents)}</strong></div>
            <div className="card kpi"><span className="muted small">Your payout (after 10 %)</span><strong>{money(d.totals.payoutCents)}</strong></div>
            <div className="card kpi"><span className="muted small">Licences sold</span><strong>{d.totals.units}</strong></div>
          </div>
          <div className="card">
            <h2 className="small muted">Revenue per day</h2>
            <Bars series={d.series} value={(x) => x.revenueCents} label={(x) => `${x.day}: ${money(x.revenueCents)} (${x.units})`} />
          </div>
          <h2>Listings</h2>
          <table className="table">
            <thead><tr><th>Product</th><th>Status</th><th>Price</th><th>Sold (30 d)</th><th>Rating</th><th>Buyers say</th><th /></tr></thead>
            <tbody>
              {d.products.map((p) => (
                <tr key={p.productId}>
                  <td><span className="row"><ProductArt image={p.image} name={p.name} size="xs" /> {p.name}</span></td>
                  <td><span className={`badge ${p.status.toLowerCase()}`}>{p.status.toLowerCase()}</span></td>
                  <td>{money(p.priceCents)}</td>
                  <td>{p.units} · {money(p.revenueCents)}</td>
                  <td><Stars value={p.reviews ? p.rating : null} count={p.reviews} /></td>
                  <td className="small">
                    {p.reviews ? `${p.mood}${p.aspects[0] ? `; most discussed: ${p.aspects[0].label} (${p.aspects[0].score >= 0 ? '+' : '−'})` : ''}` : '—'}
                    {p.mismatches > 0 && <span className="muted"> · {p.mismatches} rating/text mismatch</span>}
                  </td>
                  <td><Link className="btn small" to={`/provider/edit/${p.productId}`}>Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}</Loadable>
    </section>
  );
}

export function ListingForm() {
  const { id } = useParams();
  const { backend } = useBackend();
  const nav = useNavigate();
  const mine = useApi(id ? '/provider/products' : null);
  const existing = mine.data?.items.find((p) => p.productId === id);
  if (id && !existing) return <Loadable state={mine}>{() => <p>Listing not found.</p>}</Loadable>;
  return <Form key={id || 'new'} existing={existing} backend={backend} nav={nav} />;
}

function Form({ existing, backend, nav }) {
  const [f, setF] = useState(() => existing ? {
    name: existing.name, category: existing.category, description: existing.description, developer: existing.developer,
    platforms: existing.platforms, price: (existing.priceCents / 100).toFixed(2), tags: existing.tags.join(', '),
    features: existing.features.join('\n'), licenseType: existing.licenseType || 'Perpetual', publish: existing.status === 'PUBLISHED',
  } : { name: '', category: 'productivity', description: '', developer: '', platforms: ['Windows'], price: '19.99', tags: '', features: '', licenseType: 'Perpetual', publish: false });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    const body = {
      name: f.name, category: f.category, description: f.description, developer: f.developer, platforms: f.platforms,
      priceCents: Math.round(Number(f.price) * 100), licenseType: f.licenseType, publish: f.publish,
      tags: f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      features: f.features.split('\n').map((t) => t.trim()).filter(Boolean),
    };
    try {
      if (existing) await backend.request('PUT', `/provider/products/${existing.productId}`, { body: { ...body, ver: existing.ver } });
      else await backend.request('POST', '/provider/products', { body });
      nav('/provider');
    } catch (x) { setErr(x); }
  }
  async function archive() {
    if (!window.confirm('Archive this listing? Buyers keep their licences.')) return;
    try { await backend.request('DELETE', `/provider/products/${existing.productId}`); nav('/provider'); } catch (x) { setErr(x); }
  }
  return (
    <section className="narrow">
      <h1>{existing ? 'Edit listing' : 'New listing'}</h1>
      <form className="card stack" onSubmit={submit}>
        <label>Name<input value={f.name} onChange={set('name')} required maxLength={60} /></label>
        <div className="row">
          <label>Category<select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.title}</option>)}</select></label>
          <label>Price (CAD)<input type="number" min="0.99" step="0.01" value={f.price} onChange={set('price')} required /></label>
        </div>
        <label>Developer<input value={f.developer} onChange={set('developer')} required /></label>
        <label>Description<textarea rows={5} value={f.description} onChange={set('description')} required minLength={20} /></label>
        <fieldset className="roles"><legend>Platforms</legend>
          {PLATFORMS.map((p) => (
            <label key={p}><input type="checkbox" checked={f.platforms.includes(p)} onChange={(e) => setF({ ...f, platforms: e.target.checked ? [...f.platforms, p] : f.platforms.filter((x) => x !== p) })} /> {p}</label>
          ))}
        </fieldset>
        <label>Licence<select value={f.licenseType} onChange={set('licenseType')}>{LICENSES.map((l) => <option key={l}>{l}</option>)}</select></label>
        <label>Tags (comma-separated)<input value={f.tags} onChange={set('tags')} /></label>
        <label>Features (one per line)<textarea rows={4} value={f.features} onChange={set('features')} /></label>
        <label className="check"><input type="checkbox" checked={f.publish} onChange={set('publish')} /> Published in the catalogue</label>
        <div className="row">
          <button className="btn primary">{existing ? 'Save changes' : 'Create listing'}</button>
          {existing && <button type="button" className="btn ghost" onClick={archive}>Archive</button>}
        </div>
        <ErrorBox error={err} />
        {err?.status === 409 && <p className="small">Someone else saved this listing meanwhile. Reload to see their changes.</p>}
      </form>
    </section>
  );
}
