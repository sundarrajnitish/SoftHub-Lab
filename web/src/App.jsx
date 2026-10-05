import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BackendProvider, useBackend } from './lib/context.jsx';
import { Home, Category, Product } from './pages/Shop.jsx';
import { SignIn, SignUp, Confirm } from './pages/Account.jsx';
import { Cart, Pay, Order, Orders, Library } from './pages/Buy.jsx';
import { Dashboard, ListingForm } from './pages/Provider.jsx';
import { Admin } from './pages/Admin.jsx';

function Nav() {
  const { user, signOut, backend } = useBackend();
  const nav = useNavigate();
  const is = (g) => user?.groups.includes(g);
  return (
    <header className="nav">
      <Link to="/" className="brand"><img src="/favicon.svg" alt="" width="26" height="26" /> SoftHub</Link>
      <nav>
        {(!user || is('Consumer')) && <NavLink to="/">Shop</NavLink>}
        {is('Consumer') && <><NavLink to="/cart">Cart</NavLink><NavLink to="/orders">Orders</NavLink><NavLink to="/library">Library</NavLink></>}
        {is('Provider') && <><NavLink to="/provider" end>Sales</NavLink><NavLink to="/provider/new">New listing</NavLink></>}
        {is('Admin') && <NavLink to="/admin">Platform</NavLink>}
        {user
          ? <button className="btn small ghost" onClick={async () => { await signOut(); nav('/'); }}>Sign out</button>
          : <><NavLink to="/signin">Sign in</NavLink><NavLink to="/signup" className="btn small primary">Join</NavLink></>}
      </nav>
      {backend.mode === 'local' && <span className="mode" title="No VITE_API_URL set: the whole backend runs in this tab">local mode</span>}
    </header>
  );
}

function Guard({ role, children }) {
  const { user } = useBackend();
  const loc = useLocation();
  if (!user) return <Navigate to="/signin" state={{ next: loc.pathname }} replace />;
  if (!user.groups.includes(role)) return <section className="narrow"><h1>Not available</h1><p>This page needs a {role.toLowerCase()} account.</p></section>;
  return children;
}

export default function App() {
  return (
    <BackendProvider>
      <BrowserRouter>
        <Nav />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/c/:slug" element={<Category />} />
            <Route path="/products/:id" element={<Product />} />
            <Route path="/signin" element={<SignIn />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/confirm" element={<Confirm />} />
            <Route path="/cart" element={<Guard role="Consumer"><Cart /></Guard>} />
            <Route path="/pay/:orderId" element={<Guard role="Consumer"><Pay /></Guard>} />
            <Route path="/orders" element={<Guard role="Consumer"><Orders /></Guard>} />
            <Route path="/orders/:orderId" element={<Guard role="Consumer"><Order /></Guard>} />
            <Route path="/library" element={<Guard role="Consumer"><Library /></Guard>} />
            <Route path="/provider" element={<Guard role="Provider"><Dashboard /></Guard>} />
            <Route path="/provider/new" element={<Guard role="Provider"><ListingForm /></Guard>} />
            <Route path="/provider/edit/:id" element={<Guard role="Provider"><ListingForm /></Guard>} />
            <Route path="/admin" element={<Guard role="Admin"><Admin /></Guard>} />
            <Route path="*" element={<section className="narrow"><h1>Page not found</h1><Link to="/">Back to the shop</Link></section>} />
          </Routes>
        </main>
        <footer className="foot">SoftHub · designed and built by Nitish Sundarraj</footer>
      </BrowserRouter>
    </BackendProvider>
  );
}
