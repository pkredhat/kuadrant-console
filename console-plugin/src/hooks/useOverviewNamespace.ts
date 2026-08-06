import * as React from 'react';
import { useLocation, useHistory } from 'react-router-dom';

/**
 * Namespace filter for the Overview page.
 *
 * Source of truth is the URL query string `?namespace=X`, so the current
 * scope is bookmarkable and shareable via link. When the URL is empty
 * (fresh entry, external link, back button to before we set anything),
 * we fall back to a value cached in localStorage under
 * `rhcl-overview-namespace` — that survives page reloads and reasonable
 * amounts of navigation. `null` means "all namespaces".
 *
 * We deliberately don't couple to Console's Project dropdown: this
 * plugin page is registered at cluster scope (`/connectivity-link` with
 * no `:ns` param), and pinning to a namespace across the whole console
 * would surprise operators who came from another page.
 */
const STORAGE_KEY = 'rhcl-overview-namespace';
const URL_PARAM = 'namespace';

function readInitial(search: string): string | null {
  const params = new URLSearchParams(search);
  const fromUrl = params.get(URL_PARAM);
  if (fromUrl != null && fromUrl !== '') return fromUrl;
  try {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached && cached.trim() !== '') return cached;
  } catch {
    // localStorage can throw in privacy modes / sandboxed frames — we
    // fall back to "all namespaces" silently.
  }
  return null;
}

export function useOverviewNamespace(): {
  namespace: string | null;
  setNamespace: (ns: string | null) => void;
} {
  const location = useLocation();
  const history = useHistory();

  const [namespace, setNamespaceState] = React.useState<string | null>(() =>
    readInitial(location.search),
  );

  // Sync any external URL changes back into state (e.g. user hits Back,
  // or pastes a link with a different namespace param).
  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get(URL_PARAM);
    if (fromUrl == null || fromUrl === '') {
      // URL cleared — don't fight it, but leave the state alone; user
      // may have picked "All namespaces" locally.
      return;
    }
    if (fromUrl !== namespace) {
      setNamespaceState(fromUrl);
    }
    // Intentionally only re-run when the URL search changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const setNamespace = React.useCallback(
    (ns: string | null) => {
      setNamespaceState(ns);

      // URL — update in place, replace so we don't spam history entries.
      const params = new URLSearchParams(location.search);
      if (ns == null) {
        params.delete(URL_PARAM);
      } else {
        params.set(URL_PARAM, ns);
      }
      const nextSearch = params.toString();
      history.replace({
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      });

      // localStorage — cache for next entry.
      try {
        if (ns == null) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, ns);
      } catch {
        // Same reason as above: storage may be unavailable.
      }
    },
    [history, location.pathname, location.search],
  );

  return { namespace, setNamespace };
}
