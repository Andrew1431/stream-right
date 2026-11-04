import { useEffect, useRef, useState } from "react";
import { DESKTOP_DOWNLOAD, desktopAppLink } from "./desktop";

// "Go live in the app" beside Share screen, for Windows browsers. Browsers can't tell whether
// the app is installed, so clicking tries the stream-desktop:// link and opens a card that
// offers the download in case nothing happened. The card closes itself if the app takes focus.
export function AppLaunch() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Chrome's "Open stream?" prompt doesn't blur the page; the app coming forward does.
    const blur = () => setTimeout(() => document.hasFocus() || setOpen(false), 300);
    addEventListener("pointerdown", away);
    addEventListener("keydown", key);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", key);
      removeEventListener("blur", blur);
    };
  }, [open]);

  function launch() {
    setOpen(true);
    location.assign(desktopAppLink(location.origin + location.pathname + location.hash));
  }

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        type="button"
        className={`app-key${open ? " active" : ""}`}
        title="Stream a game in two clicks with the stream app for Windows"
        aria-label="Go live in the app"
        onClick={() => (open ? setOpen(false) : launch())}
      >
        <AppGlyph />
        <span className="app-key-label">Go live in the app</span>
      </button>
      {open && (
        <div className="room-menu app-card" role="dialog" aria-label="The stream desktop app">
          <p className="app-card-lede">Opening this room in the stream app…</p>
          <p className="menu-hint">
            Nothing happened? Get the free Windows app: it streams your game on your graphics card,
            with just that game's sound, and updates itself. Have an older version? Update it to open
            links.
          </p>
          <a className="button app-card-download" href={DESKTOP_DOWNLOAD} target="_blank" rel="noopener">
            Download for Windows
          </a>
        </div>
      )}
    </div>
  );
}

function AppGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="7" r="1.8" fill="var(--tally)" />
    </svg>
  );
}
