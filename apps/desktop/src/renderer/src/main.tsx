import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { LockScreen } from "./components/LockScreen.js";
import { useStore } from "./store.js";
import type { LockState } from "../../shared/ipc.js";
import "./styles.css";

/**
 * Texts are looked up as they render, so a change of language rebuilds the
 * tree under the new one. What must survive it — the conversation, the queue
 * — lives in the store, not in components.
 *
 * The lock sits over it all. Opened locked, the app isn't even mounted until
 * the owner unlocks — it would only ask main for things main refuses. Locked
 * again later, the app stays mounted underneath so it keeps hearing the run.
 */
function Root({ initialLock }: { initialLock: LockState }) {
  const locale = useStore((s) => s.locale);
  const [lock, setLock] = useState(initialLock);
  const [opened, setOpened] = useState(!initialLock.locked);

  const apply = (next: LockState) => {
    setLock(next);
    if (!next.locked) setOpened(true);
    // A locked Vunemi neither listens nor talks: drop the microphone and
    // the hands-free loop that would open it again.
    else {
      const voice = useStore.getState();
      voice.setHandsFree(false);
      voice.cancelListening();
    }
  };
  useEffect(() => window.ocak.onLock(apply), []);

  return (
    <>
      {opened && <App key={locale} />}
      {lock.locked && <LockScreen key={locale} away={lock.away} onState={apply} />}
    </>
  );
}

// The language first: drawn before it arrives, the window would flash
// Turkish at someone who chose Japanese. The lock too, so a locked Vunemi
// never flashes the conversation.
const unknownLock: LockState = { enabled: true, locked: true, away: false };
void Promise.all([
  window.ocak
    .getLanguage()
    .then((locale) => useStore.getState().applyLocale(locale))
    .catch(() => undefined),
  window.ocak.getLock().catch(() => unknownLock),
]).then(([, lock]) => {
  window.ocak.onLanguage((locale) => useStore.getState().applyLocale(locale));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root initialLock={lock} />
    </StrictMode>,
  );
});
