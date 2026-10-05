import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useBackend, useRole } from '../lib/context.jsx';
import { money } from '../lib/backend.js';
import { ProductArt, ProductCard, Stars, Loadable, ErrorBox } from '../components/ui.jsx';

export function Home() {
  const cats = useApi('/categories');
  const popular = useApi('/products', { sort: 'popular', limit: 8 });
  const isConsumer = useRole('Consumer');
  const mine = useApi(isConsumer ? '/me/recommendations' : null);
  return (
    <>
      <section className="hero">
        <h1>Software, delivered instantly.</h1>
        <p>Buy once, get your licence key by e-mail in seconds, download any time from your library.</p>
      </section>
      {isConsumer && mine.data?.items?.length > 0 && (
        <section>
          <h2>Picked for you</h2>
          <div className="grid">{mine.data.items.map((p) => <ProductCard key={p.productId} p={p} reason={p.reason} />)}</div>
        </section>
      )}
      <section>
        <h2>Categories</h2>
        <Loadable state={cats}>{(d) => (
          <div className="cat-grid">
            {d.items.map((c) => (
              <Link key={c.slug} to={`/c/${c.slug}`} className="card cat-card">
                <h3>{c.title}</h3>
                <p className="muted small">{c.blurb}</p>
              </Link>
            ))}
          </div>
        )}</Loadable>
      </section>
      <section>
        <h2>Popular right now</h2>
        <Loadable state={popular}>{(d) => <div className="grid">{d.items.map((p) => <ProductCard key={p.productId} p={p} />)}</div>}</Loadable>
      </section>
    </>
  );
}

export function Category() {
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const q = Object.fromEntries(params);
  const list = useApi('/products', { category: slug, ...q });
  const set = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  return (
    <section>
      <h1 className="cap">{slug.replace(/-/g, ' ')}</h1>
      <div className="filters">
        <input type="search" placeholder="Search name, studio or tag" defaultValue={q.q || ''} onKeyDown={(e) => e.key === 'Enter' && set('q', e.target.value)} aria-label="Search" />
        <select value={q.sort || 'popular'} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
          <option value="popular">Most bought</option>
          <option value="rating">Best rated</option>
          <option value="price">Price: low to high</option>
          <option value="-price">Price: high to low</option>
          <option value="name">Name</option>
        </select>
        <select value={q.maxPrice || ''} onChange={(e) => set('maxPrice', e.target.value)} aria-label="Maximum price">
          <option value="">Any price</option>
          <option value="2000">Under $20</option>
          <option value="5000">Under $50</option>
          <option value="10000">Under $100</option>
        </select>
        <select value={q.minRating || ''} onChange={(e) => set('minRating', e.target.value)} aria-label="Minimum rating">
          <option value="">Any rating</option>
          <option value="4">4★ and up</option>
          <option value="3">3★ and up</option>
        </select>
      </div>
      <Loadable state={list}>{(d) => (d.items.length
        ? <div className="grid">{d.items.map((p) => <ProductCard key={p.productId} p={p} />)}</div>
        : <p className="muted">Nothing matches those filters.</p>)}</Loadable>
    </section>
  );
}

export function Product() {
  const { id } = useParams();
  const { backend, user } = useBackend();
  const nav = useNavigate();
  const product = useApi(`/products/${id}`);
  const insights = useApi(`/products/${id}/insights`);
  const related = useApi(`/products/${id}/related`);
  const reviews = useApi(`/products/${id}/reviews`);
  const isConsumer = useRole('Consumer');
  const library = useApi(isConsumer ? '/library' : null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const owned = library.data?.items?.some((l) => l.productId === id && l.status === 'ACTIVE');

  async function addToCart() {
    if (!user) return nav('/signin', { state: { next: `/products/${id}` } });
    setBusy(true); setErr(null);
    try { await backend.request('PUT', `/cart/${id}`); nav('/cart'); } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Loadable state={product}>{(p) => (
      <article className="product">
        <header className="product-head">
          <ProductArt image={p.image} name={p.name} size="lg" />
          <div>
            <p className="muted small cap">{p.category.replace(/-/g, ' ')}</p>
            <h1>{p.name}</h1>
            <p className="muted">{p.developer} · {p.platforms.join(', ')} · {p.licenseType}</p>
            <Stars value={p.rating} count={p.reviewCount} />
            <div className="buy-row">
              <strong className="price big">{money(p.priceCents)}</strong>
              {owned
                ? <Link className="btn" to="/library">In your library</Link>
                : <button className="btn primary" onClick={addToCart} disabled={busy || (user && !isConsumer)}>{busy ? 'Adding…' : 'Add to cart'}</button>}
            </div>
            {user && !isConsumer && <p className="muted small">Sign in with a buyer account to purchase.</p>}
            <ErrorBox error={err} />
          </div>
        </header>
        <section className="two-col">
          <div>
            <h2>About</h2>
            <p className="pre">{p.description}</p>
            {p.features.length > 0 && <ul className="ticks">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>}
            <p className="tags">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</p>
          </div>
          <aside>
            <h2>What buyers say</h2>
            <Loadable state={insights}>{(s) => (
              <div className="insights">
                <p>{s.headline}</p>
                {s.aspects?.length > 0 && (
                  <ul className="aspects">
                    {s.aspects.slice(0, 5).map((a) => (
                      <li key={a.aspect}>
                        <span>{a.label}</span>
                        <span className="meter"><span className={a.score >= 0 ? 'pos' : 'neg'} style={{ width: `${Math.min(100, Math.abs(a.score) * 100)}%` }} /></span>
                        <span className="small muted">{a.mentions}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {s.highlights?.praise && <blockquote className="pos">“{s.highlights.praise.text}”</blockquote>}
                {s.highlights?.complaint && <blockquote className="neg">“{s.highlights.complaint.text}”</blockquote>}
              </div>
            )}</Loadable>
          </aside>
        </section>
        <section>
          <h2>Reviews</h2>
          {owned && <ReviewForm productId={id} onDone={() => { reviews.reload(); insights.reload(); product.reload(); }} />}
          <Loadable state={reviews}>{(d) => (d.items.length ? (
            <ul className="reviews">
              {d.items.map((r) => (
                <li key={r.reviewId} className="card">
                  <div className="row"><Stars value={r.stars} /><span className={`badge ${r.sentiment.label}`}>{r.sentiment.label}</span></div>
                  <p>{r.text}</p>
                  <p className="small muted">{r.author} · verified purchase · {new Date(r.createdAt).toLocaleDateString('en-CA')}{r.editedAt ? ' (edited)' : ''}</p>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No reviews yet.</p>)}</Loadable>
        </section>
        <section>
          <h2>You may also like</h2>
          <Loadable state={related}>{(d) => <div className="grid">{d.items.map((r) => <ProductCard key={r.productId} p={r} reason={r.reason} />)}</div>}</Loadable>
        </section>
      </article>
    )}</Loadable>
  );
}

function ReviewForm({ productId, onDone }) {
  const { backend } = useBackend();
  const [stars, setStars] = useState(5);
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await backend.request('POST', `/products/${productId}/reviews`, { body: { stars, text } });
      setSaved(r); setText(''); onDone();
    } catch (x) { setErr(x); }
  }
  return (
    <form className="card review-form" onSubmit={submit}>
      <label>Your rating
        <select value={stars} onChange={(e) => setStars(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{'★'.repeat(s)}</option>)}</select>
      </label>
      <label>Your review<textarea value={text} onChange={(e) => setText(e.target.value)} minLength={10} maxLength={2000} required rows={3} /></label>
      <button className="btn primary">Post review</button>
      {saved && <p className="small muted">Saved — read as <b>{saved.sentiment.label}</b> ({saved.sentiment.compound}).</p>}
      <ErrorBox error={err} />
    </form>
  );
}
