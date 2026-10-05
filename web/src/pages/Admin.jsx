import { useState } from 'react';
import { useApi, useBackend } from '../lib/context.jsx';
import { money } from '../lib/backend.js';
import { Loadable, ErrorBox, Bars } from '../components/ui.jsx';

export function Admin() {
  const { backend } = useBackend();
  const metrics = useApi('/admin/metrics');
  const [email, setEmail] = useState('');
  const [user, setUser] = useState(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);

  async function find(e) {
    e.preventDefault();
    setErr(null); setUser(null);
    try { setUser(await backend.request('GET', '/admin/users', { query: { email } })); } catch (x) { setErr(x); }
  }
  async function setStatus(status) {
    setErr(null);
    try {
      await backend.request('PUT', `/admin/users/${user.sub}/status`, { body: { status, reason } });
      setUser({ ...user, status, statusReason: reason });
    } catch (x) { setErr(x); }
  }

  return (
    <section>
      <h1>Platform</h1>
      <Loadable state={metrics}>{(m) => (
        <>
          <div className="kpis">
            <div className="card kpi"><span className="muted small">Orders, 30 days</span><strong>{m.totals.orders}</strong></div>
            <div className="card kpi"><span className="muted small">Gross sales</span><strong>{money(m.totals.gmvCents)}</strong></div>
            <div className="card kpi"><span className="muted small">Commission (10 %)</span><strong>{money(m.commissionCents)}</strong></div>
            <div className="card kpi"><span className="muted small">Payment success</span><strong>{m.paymentSuccessRate ?? '—'} %</strong></div>
            <div className="card kpi"><span className="muted small">New accounts</span><strong>{m.totals.signups}</strong></div>
            <div className="card kpi"><span className="muted small">Reviews</span><strong>{m.totals.reviews}</strong></div>
          </div>
          <div className="card">
            <h2 className="small muted">Orders per day</h2>
            <Bars series={m.days} value={(d) => d.orders} label={(d) => `${d.day}: ${d.orders} orders, ${money(d.gmvCents)}`} />
          </div>
        </>
      )}</Loadable>
      <h2>Accounts</h2>
      <form className="row" onSubmit={find}>
        <input type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="E-mail" />
        <button className="btn">Find</button>
      </form>
      <ErrorBox error={err} />
      {user && (
        <div className="card stack narrow">
          <p><b>{user.email}</b> · {user.role} · <span className={`badge ${user.status.toLowerCase()}`}>{user.status.toLowerCase()}</span></p>
          {user.statusReason && <p className="small muted">Reason: {user.statusReason}</p>}
          <label>Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} /></label>
          <div className="row">
            {user.status === 'ACTIVE'
              ? <button className="btn danger" disabled={reason.length < 3} onClick={() => setStatus('SUSPENDED')}>Suspend</button>
              : <button className="btn primary" disabled={reason.length < 3} onClick={() => setStatus('ACTIVE')}>Reinstate</button>}
          </div>
          <p className="small muted">Suspension disables sign-in and is enforced on every API call within 30 seconds, even for tokens already issued.</p>
        </div>
      )}
    </section>
  );
}
