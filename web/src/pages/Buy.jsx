import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useApi, useBackend } from '../lib/context.jsx';
import { money, newIdempotencyKey } from '../lib/backend.js';
import { ProductArt, Loadable, ErrorBox, Spinner } from '../components/ui.jsx';
import { TEST_CARDS } from '@core/payments.js';

export function Cart() {
  const { backend } = useBackend();
  const cart = useApi('/cart');
  const nav = useNavigate();
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function remove(id) {
    try { await backend.request('DELETE', `/cart/${id}`); cart.reload(); } catch (e) { setErr(e); }
  }
  async function checkout() {
    setBusy(true); setErr(null);
    // one key per checkout attempt: a double click or a network retry replays it
    const key = sessionStorage.getItem('softhub.checkoutKey') || newIdempotencyKey();
    sessionStorage.setItem('softhub.checkoutKey', key);
    try {
      const order = await backend.request('POST', '/checkout', { headers: { 'Idempotency-Key': key }, body: {} });
      sessionStorage.removeItem('softhub.checkoutKey');
      sessionStorage.setItem(`softhub.pay.${order.orderId}`, JSON.stringify(order));
      nav(`/pay/${order.orderId}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <section className="narrow">
      <h1>Your cart</h1>
      <Loadable state={cart}>{(c) => (
        <>
          {c.items.length === 0 && <p className="muted">Your cart is empty. <Link to="/">Browse the catalogue</Link></p>}
          <ul className="lines">
            {c.items.map((p) => (
              <li key={p.productId} className="card line">
                <ProductArt image={p.image} name={p.name} size="sm" />
                <Link to={`/products/${p.productId}`}>{p.name}</Link>
                <span className="price">{money(p.priceCents)}</span>
                <button className="btn small ghost" onClick={() => remove(p.productId)} aria-label={`Remove ${p.name}`}>Remove</button>
              </li>
            ))}
          </ul>
          {c.unavailable.length > 0 && <p className="muted small">{c.unavailable.length} item(s) can't be bought ({c.unavailable.map((u) => u.reason).join(', ')}) and will be skipped.</p>}
          {c.items.length > 0 && (
            <div className="total card">
              <span>Total</span><strong className="price big">{money(c.totalCents)}</strong>
              <button className="btn primary" onClick={checkout} disabled={busy}>{busy ? 'Starting checkout…' : 'Checkout'}</button>
            </div>
          )}
        </>
      )}</Loadable>
      <ErrorBox error={err} />
    </section>
  );
}

export function Pay() {
  const { orderId } = useParams();
  const { backend } = useBackend();
  const order = JSON.parse(sessionStorage.getItem(`softhub.pay.${orderId}`) || 'null');
  if (!order) return <section className="narrow"><p>This payment session expired. <Link to={`/orders/${orderId}`}>View the order</Link></p></section>;
  return (
    <section className="narrow">
      <h1>Pay {money(order.amountCents)}</h1>
      <ul className="lines compact">{order.lines.map((l) => <li key={l.productId}>{l.name} <span className="price">{money(l.priceCents)}</span></li>)}</ul>
      {backend.mode === 'aws'
        ? <Elements stripe={backend.stripePromise} options={{ clientSecret: order.clientSecret, appearance: { theme: 'night' } }}><StripeForm order={order} /></Elements>
        : <TestCardForm order={order} />}
      <p className="small muted">Your licence keys are issued when the payment provider confirms the charge — not by this page — so closing the tab after paying is safe.</p>
    </section>
  );
}

function StripeForm({ order }) {
  const stripe = useStripe();
  const elements = useElements();
  const nav = useNavigate();
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setErr(null);
    const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: `${location.origin}/orders/${order.orderId}` } });
    setBusy(false);
    if (error) setErr(error); else nav(`/orders/${order.orderId}`);
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <PaymentElement />
      <button className="btn primary" disabled={busy || !stripe}>{busy ? 'Paying…' : `Pay ${money(order.amountCents)}`}</button>
      <ErrorBox error={err} />
    </form>
  );
}

function TestCardForm({ order }) {
  const { backend } = useBackend();
  const nav = useNavigate();
  const [card, setCard] = useState({ number: TEST_CARDS[0].number, exp: '12/34', cvc: '123' });
  const [err, setErr] = useState(null);
  const [challenge, setChallenge] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await backend.runtime.pay(order.clientSecret, card);
    setBusy(false);
    if (r.requiresAction) return setChallenge(true);
    if (r.error) return setErr(r.error);
    nav(`/orders/${order.orderId}`);
  }
  async function resolve(ok) {
    const r = await backend.runtime.stripe.handleNextAction(order.clientSecret, ok);
    setChallenge(false);
    if (r.error) setErr(r.error); else nav(`/orders/${order.orderId}`);
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <label>Test card
        <select value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })}>
          {TEST_CARDS.map((c) => <option key={c.number} value={c.number}>{c.number} — {c.label}</option>)}
        </select>
      </label>
      <div className="row">
        <label>Expiry<input value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} placeholder="MM/YY" /></label>
        <label>CVC<input value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} /></label>
      </div>
      <button className="btn primary" disabled={busy}>{busy ? 'Paying…' : `Pay ${money(order.amountCents)}`}</button>
      {challenge && (
        <div className="card challenge" role="dialog" aria-label="3-D Secure">
          <p><b>Your bank wants to confirm it's you.</b></p>
          <button type="button" className="btn primary" onClick={() => resolve(true)}>Approve</button>{' '}
          <button type="button" className="btn ghost" onClick={() => resolve(false)}>Fail authentication</button>
        </div>
      )}
      <ErrorBox error={err} />
    </form>
  );
}

export function Order() {
  const { orderId } = useParams();
  const { backend } = useBackend();
  const order = useApi(`/orders/${orderId}`);
  const [dl, setDl] = useState({});
  const pending = order.data?.status === 'PENDING_PAYMENT';
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => order.reload(), 1500); // until the webhook has fulfilled it
    return () => clearInterval(t);
  }, [pending, order.reload]);
  async function download(productId) {
    const r = await backend.request('GET', `/orders/${orderId}/downloads/${productId}`);
    setDl({ ...dl, [productId]: r.url });
  }
  return (
    <section className="narrow">
      <Loadable state={order}>{(o) => (
        <>
          <h1>Order {o.orderId.slice(-8)}</h1>
          <p><span className={`badge ${o.status.toLowerCase()}`}>{o.status.replace(/_/g, ' ').toLowerCase()}</span> · {money(o.amountCents)}{o.refundedCents ? ` · ${money(o.refundedCents)} refunded` : ''}</p>
          {pending && <p className="muted"><Spinner /> Waiting for the payment confirmation…{o.lastError && ` Last attempt: ${o.lastError.replace(/_/g, ' ')}.`} {o.lastError && <Link to={`/pay/${o.orderId}`}>Try another card</Link>}</p>}
          <ul className="lines">
            {o.lines.map((l) => (
              <li key={l.productId} className="card line wrap">
                <Link to={`/products/${l.productId}`}>{l.name}</Link>
                <span className="price">{money(l.priceCents)}</span>
                {l.licenseKey && <code className="key">{l.licenseKey}</code>}
                {l.status === 'REFUNDED_DUPLICATE' && <span className="small muted">already owned — refunded</span>}
                {l.licenseKey && (dl[l.productId]
                  ? <a className="btn small" href={dl[l.productId]}>Download (link valid 5 min)</a>
                  : <button className="btn small" onClick={() => download(l.productId)}>Get download link</button>)}
              </li>
            ))}
          </ul>
        </>
      )}</Loadable>
    </section>
  );
}

export function Orders() {
  const orders = useApi('/orders');
  return (
    <section className="narrow">
      <h1>Orders</h1>
      <Loadable state={orders}>{(d) => (d.items.length ? (
        <ul className="lines">
          {d.items.map((o) => (
            <li key={o.orderId} className="card line">
              <Link to={`/orders/${o.orderId}`}>Order {o.orderId.slice(-8)}</Link>
              <span className="small muted">{new Date(o.createdAt).toLocaleString('en-CA')}</span>
              <span className={`badge ${o.status.toLowerCase()}`}>{o.status.replace(/_/g, ' ').toLowerCase()}</span>
              <span className="price">{money(o.amountCents)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No orders yet.</p>)}</Loadable>
    </section>
  );
}

export function Library() {
  const lib = useApi('/library');
  return (
    <section className="narrow">
      <h1>Your library</h1>
      <Loadable state={lib}>{(d) => (d.items.length ? (
        <ul className="lines">
          {d.items.map((l) => (
            <li key={l.productId} className="card line wrap">
              <ProductArt image={l.image} name={l.name} size="sm" />
              <Link to={`/products/${l.productId}`}>{l.name}</Link>
              {l.licenseKey ? <code className="key">{l.licenseKey}</code> : <span className="badge negative">{l.status.toLowerCase()}</span>}
              <Link className="btn small" to={`/orders/${l.orderId}`}>Order & download</Link>
            </li>
          ))}
        </ul>
      ) : <p className="muted">Nothing here yet.</p>)}</Loadable>
    </section>
  );
}
