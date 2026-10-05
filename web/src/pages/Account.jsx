import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useBackend } from '../lib/context.jsx';
import { ErrorBox } from '../components/ui.jsx';

export function SignIn() {
  const { signIn, backend } = useBackend();
  const nav = useNavigate();
  const loc = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [err, setErr] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    try {
      const u = await signIn(form);
      nav(loc.state?.next || (u.groups.includes('Provider') ? '/provider' : u.groups.includes('Admin') ? '/admin' : '/'));
    } catch (x) { setErr(x); }
  }
  return (
    <section className="narrow">
      <h1>Sign in</h1>
      <form className="card stack" onSubmit={submit}>
        <label>E-mail<input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <button className="btn primary">Sign in</button>
        <ErrorBox error={err} />
      </form>
      <p className="muted">New here? <Link to="/signup">Create an account</Link></p>
      {backend.demoAccounts && (
        <div className="card demo">
          <p className="small"><b>Local demo accounts</b> (this tab runs the whole backend):</p>
          {Object.entries(backend.demoAccounts).map(([role, a]) => (
            <button key={role} className="btn small" onClick={() => setForm({ email: a.email, password: a.password })}>{role}: {a.email}</button>
          ))}
        </div>
      )}
    </section>
  );
}

export function SignUp() {
  const { backend } = useBackend();
  const nav = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', role: 'Consumer' });
  const [err, setErr] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    try {
      await backend.auth.signUp(form);
      nav('/confirm', { state: { email: form.email } });
    } catch (x) { setErr(x); }
  }
  return (
    <section className="narrow">
      <h1>Create an account</h1>
      <form className="card stack" onSubmit={submit}>
        <label>E-mail<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
        <label>Password<input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <p className="small muted">At least 8 characters with upper- and lower-case letters and a digit.</p>
        <fieldset className="roles">
          <legend>I want to</legend>
          <label><input type="radio" name="role" checked={form.role === 'Consumer'} onChange={() => setForm({ ...form, role: 'Consumer' })} /> buy software</label>
          <label><input type="radio" name="role" checked={form.role === 'Provider'} onChange={() => setForm({ ...form, role: 'Provider' })} /> sell my software</label>
        </fieldset>
        <button className="btn primary">Send verification code</button>
        <ErrorBox error={err} />
      </form>
    </section>
  );
}

export function Confirm() {
  const { backend } = useBackend();
  const loc = useLocation();
  const nav = useNavigate();
  const [email, setEmail] = useState(loc.state?.email || '');
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const inbox = backend.runtime?.mailer.inbox(email.trim().toLowerCase()).filter((m) => m.kind === 'verify').at(-1);
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    try { await backend.auth.confirm({ email, code }); nav('/signin'); } catch (x) { setErr(x); }
  }
  return (
    <section className="narrow">
      <h1>Check your e-mail</h1>
      <form className="card stack" onSubmit={submit}>
        <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>6-digit code<input inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
        <button className="btn primary">Confirm</button>
        <ErrorBox error={err} />
      </form>
      {inbox && <p className="card small">Local mode inbox: your code is <b>{inbox.code}</b></p>}
    </section>
  );
}
