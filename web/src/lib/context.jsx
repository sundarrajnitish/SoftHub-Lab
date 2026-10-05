import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getBackend } from './backend.js';

const Ctx = createContext(null);

export function BackendProvider({ children }) {
  const [state, setState] = useState({ backend: null, user: null, error: null });
  useEffect(() => {
    let alive = true;
    getBackend()
      .then(async (backend) => {
        const user = await backend.auth.current();
        if (alive) setState({ backend, user, error: null });
      })
      .catch((error) => alive && setState((s) => ({ ...s, error })));
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async (creds) => {
    const user = await state.backend.auth.signIn(creds);
    setState((s) => ({ ...s, user }));
    return user;
  }, [state.backend]);

  const signOut = useCallback(async () => {
    await state.backend.auth.signOut();
    setState((s) => ({ ...s, user: null }));
  }, [state.backend]);

  if (state.error) return <div className="boot"><h1>SoftHub</h1><p className="error">Could not start: {String(state.error.message || state.error)}</p></div>;
  if (!state.backend) return <div className="boot"><h1>SoftHub</h1><p>Starting the marketplace…</p><div className="spinner" /></div>;
  return <Ctx.Provider value={{ ...state, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useBackend = () => useContext(Ctx);

export function useRole(role) {
  const { user } = useBackend();
  return !!user && user.groups.includes(role);
}

/** Fetch helper with loading/error state and a reload function. */
export function useApi(path, query, deps = []) {
  const { backend } = useBackend();
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const key = JSON.stringify([path, query]);
  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await backend.request('GET', path, { query });
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, key, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}
