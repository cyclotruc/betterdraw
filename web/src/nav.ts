// Client-side navigation without a router library.
import { useEffect, useState } from "react";

export const navigate = (path: string, replace = false) => {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};

// Set just before the page leaves on purpose (signing in, out, deleting the account), so a guest is not
// asked whether they really want to leave.
export const leaving = { onPurpose: false };

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setMatch(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return match;
}

// An admin watching a canvas unseen (opened from the admin with ?watch): read-only, and nothing of theirs is
// sent or shown to the people in it.
export const watching = () => new URLSearchParams(location.search).has("watch");
