import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { load, save } from "./storage";

const POS_STORE = "previewPos";
const COLLAPSED_STORE = "previewCollapsed";
const WIDTH_STORE = "previewWidth";
const EDGE = 8;
const MIN_WIDTH = 200;
const MAX_WIDTH = 960;
const DEFAULT_WIDTH = 320;
const KEY_STEP = 20;

type Pos = { right: number; bottom: number };

// Floating corner panel for what you're sending. Drag it by the header, resize it from the
// top-left corner, collapse it to a pill, or blow it up to a centered overlay or fullscreen.
// Position is kept as an offset from the bottom-right so it stays put when the window resizes.
// Tiles inside keep 16:9, so setting the width keeps the aspect ratio.
export function SelfPreview(props: { title: string; children: ReactNode; onLargeChange?: (large: boolean) => void }) {
  const [pos, setPos] = useState<Pos>(() => load(POS_STORE, { right: 16, bottom: 16 }));
  const [width, setWidth] = useState(() => clampWidth(Number(load(WIDTH_STORE, DEFAULT_WIDTH)) || DEFAULT_WIDTH));
  const [collapsed, setCollapsed] = useState(() => load(COLLAPSED_STORE, false));
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const expandKey = useRef<HTMLButtonElement>(null);
  const shrinkKey = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; start: Pos } | null>(null);
  const resize = useRef<{ x: number; start: number } | null>(null);
  const large = expanded || fullscreen;

  const onLargeChange = useRef(props.onLargeChange);
  onLargeChange.current = props.onLargeChange;
  useEffect(() => onLargeChange.current?.(large), [large]);
  useEffect(() => () => onLargeChange.current?.(false), []);

  // Keep it on screen if the window shrinks.
  useEffect(() => {
    const clampToWindow = () => {
      setWidth((w) => clampWidth(w));
      fitRef.current();
    };
    addEventListener("resize", clampToWindow);
    return () => removeEventListener("resize", clampToWindow);
  }, []);

  useEffect(() => {
    const update = () => setFullscreen(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      if (box.current && document.fullscreenElement === box.current) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Escape leaves the overlay. In fullscreen the browser takes Escape for itself first.
  useEffect(() => {
    if (!expanded) return;
    shrinkKey.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (large || (e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, start: pos };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setPos(clamp({ right: d.start.right - (e.clientX - d.x), bottom: d.start.bottom - (e.clientY - d.y) }, box.current));
  }

  function onPointerUp() {
    if (!drag.current) return;
    drag.current = null;
    setPos((p) => {
      save(POS_STORE, p);
      return p;
    });
  }

  // The handle sits top-left, opposite the bottom-right anchor, so dragging left or up grows it.
  function onResizeDown(e: PointerEvent<HTMLDivElement>) {
    resize.current = { x: e.clientX, start: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onResizeMove(e: PointerEvent<HTMLDivElement>) {
    const r = resize.current;
    if (!r) return;
    setWidth(clampWidth(r.start - (e.clientX - r.x)));
  }

  function onResizeUp() {
    if (!resize.current) return;
    resize.current = null;
    save(WIDTH_STORE, width);
  }

  function onResizeKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next: ((w: number) => number) | null =
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? (w) => w + step
      : e.key === "ArrowRight" || e.key === "ArrowDown" ? (w) => w - step
      : e.key === "Home" ? () => MIN_WIDTH
      : e.key === "End" ? () => MAX_WIDTH
      : null;
    if (!next) return;
    e.preventDefault();
    setWidth((w) => clampWidth(next(w)));
  }

  // Too tall for the window: shrink the width until it fits, since the tiles scale with it.
  // Then keep the bar on screen, as growing toward the top-left can push it off.
  function fit() {
    const el = box.current;
    if (!el || large) return;
    const avail = viewport().h - 2 * EDGE;
    // Past the box's max height the tiles squash, so work from the 16:9 height they want.
    const tiles = [...el.querySelectorAll<HTMLElement>(".self-preview-body > .tile")];
    const shown = tiles.reduce((h, t) => h + t.offsetHeight, 0);
    const wanted = tiles.reduce((h, t) => h + (t.offsetWidth * 9) / 16, 0);
    const fixed = el.offsetHeight - shown;
    if (!collapsed && wanted > 0 && fixed + wanted > avail + 1) {
      const next = clampWidth(Math.min(width - 1, Math.floor((width * (avail - fixed)) / wanted)));
      if (next < width) return setWidth(next);
    }
    setPos((p) => clamp(p, el));
  }
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useLayoutEffect(() => {
    fit();
    if (!resize.current) save(WIDTH_STORE, width);
  }, [width, collapsed, large]);

  function toggle() {
    setCollapsed((c) => {
      save(COLLAPSED_STORE, !c);
      return !c;
    });
  }

  function expand() {
    if (collapsed) toggle();
    setExpanded(true);
  }

  function shrink() {
    setExpanded(false);
    requestAnimationFrame(() => expandKey.current?.focus());
  }

  function toggleFullscreen() {
    if (fullscreen) document.exitFullscreen().catch(() => {});
    else {
      if (collapsed) toggle();
      box.current?.requestFullscreen().catch(() => {});
    }
  }

  const className = ["self-preview", collapsed && !large && "collapsed", expanded && "expanded", fullscreen && "fullscreen"]
    .filter(Boolean)
    .join(" ");
  const style = expanded || fullscreen ? undefined : { right: pos.right, bottom: pos.bottom, width: collapsed ? undefined : width };
  const showBody = !collapsed || large;

  return (
    <>
      {expanded && !fullscreen && <div className="self-preview-scrim" onClick={shrink} aria-hidden="true" />}
      <div
        ref={box}
        className={className}
        style={style}
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded && !fullscreen ? true : undefined}
        aria-label={expanded ? props.title : undefined}
      >
        <div
          className="self-preview-bar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          title={large ? undefined : "Drag to move"}
        >
          <span className="live-dot" />
          <span className="grow">{props.title}</span>
          {showBody && (
            <button type="button" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
              <FullscreenGlyph exit={fullscreen} />
            </button>
          )}
          {!fullscreen &&
            (expanded ? (
              <button ref={shrinkKey} type="button" onClick={shrink} title="Back to the corner (Esc)" aria-label="Back to the corner">
                <ExpandGlyph shrink />
              </button>
            ) : (
              <button ref={expandKey} type="button" onClick={expand} title="Make it bigger" aria-label="Make the preview bigger">
                <ExpandGlyph />
              </button>
            ))}
          {!large && (
            <button type="button" onClick={toggle} title={collapsed ? "Show preview" : "Hide preview"} aria-label={collapsed ? "Show preview" : "Hide preview"} aria-expanded={!collapsed}>
              {collapsed ? "▴" : "▾"}
            </button>
          )}
        </div>
        {showBody && <div className="self-preview-body">{props.children}</div>}
        {showBody && !large && (
          <div
            className="self-preview-resize"
            role="slider"
            tabIndex={0}
            aria-label="Preview size"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={width}
            aria-valuetext={`${width} pixels wide`}
            title="Drag to resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            onKeyDown={onResizeKey}
          />
        )}
      </div>
    </>
  );
}

// The window minus any scrollbars, which fixed boxes can't sit under.
function viewport() {
  const root = document.documentElement;
  return { w: root.clientWidth || innerWidth, h: root.clientHeight || innerHeight };
}

function clampWidth(w: number): number {
  return Math.round(Math.min(Math.max(MIN_WIDTH, w), MAX_WIDTH, Math.max(MIN_WIDTH, viewport().w - 2 * EDGE)));
}

function clamp(p: Pos, el: HTMLElement | null): Pos {
  const w = el?.offsetWidth ?? 240;
  const h = el?.offsetHeight ?? 40;
  const { w: vw, h: vh } = viewport();
  return {
    right: Math.min(Math.max(EDGE, p.right), vw - w - EDGE),
    bottom: Math.min(Math.max(EDGE, p.bottom), vh - h - EDGE),
  };
}

function ExpandGlyph({ shrink }: { shrink?: boolean }) {
  // Two diagonal arrows: outward to grow, inward to shrink.
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {shrink ? (
        <path d="M9.5 2.5v4h4M9.5 6.5l4.5-4.5M6.5 13.5v-4h-4M6.5 9.5L2 14" />
      ) : (
        <path d="M10 2h4v4M14 2L9.5 6.5M6 14H2v-4M2 14l4.5-4.5" />
      )}
    </svg>
  );
}

function FullscreenGlyph({ exit }: { exit?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {exit ? (
        <path d="M5.5 1.5v4h-4M10.5 1.5v4h4M5.5 14.5v-4h-4M10.5 14.5v-4h4" />
      ) : (
        <path d="M1.5 5.5v-4h4M14.5 5.5v-4h-4M1.5 10.5v4h4M14.5 10.5v4h-4" />
      )}
    </svg>
  );
}

// True while the page is visible and the window has focus. Previews pause otherwise,
// the way Discord does, since nobody is looking at them.
export function usePageActive(): { active: boolean; visible: boolean } {
  const read = () => ({ visible: !document.hidden, focused: document.hasFocus() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    document.addEventListener("visibilitychange", update);
    addEventListener("focus", update);
    addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      removeEventListener("focus", update);
      removeEventListener("blur", update);
    };
  }, []);
  return { active: state.visible && state.focused, visible: state.visible };
}

// True once the page has been hidden for `delayMs`; flips back immediately when shown.
export function useHiddenFor(delayMs: number): boolean {
  const { visible } = usePageActive();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (visible) return setHidden(false);
    const t = setTimeout(() => setHidden(true), delayMs);
    return () => clearTimeout(t);
  }, [visible, delayMs]);
  return hidden;
}
