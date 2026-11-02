import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { load, save } from "./storage";

const POS_STORE = "previewPos";
const COLLAPSED_STORE = "previewCollapsed";
const EDGE = 8;

type Pos = { right: number; bottom: number };

// Floating corner panel for what you're sending. Drag it by the header; collapse it to a pill.
// Position is kept as an offset from the bottom-right so it stays put when the window resizes.
export function SelfPreview(props: { title: string; children: ReactNode }) {
  const [pos, setPos] = useState<Pos>(() => load(POS_STORE, { right: 16, bottom: 16 }));
  const [collapsed, setCollapsed] = useState(() => load(COLLAPSED_STORE, false));
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: Pos } | null>(null);

  // Keep it on screen if the window shrinks.
  useEffect(() => {
    const clampToWindow = () => setPos((p) => clamp(p, box.current));
    addEventListener("resize", clampToWindow);
    return () => removeEventListener("resize", clampToWindow);
  }, []);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button")) return;
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

  function toggle() {
    setCollapsed((c) => {
      save(COLLAPSED_STORE, !c);
      return !c;
    });
  }

  return (
    <div ref={box} className={collapsed ? "self-preview collapsed" : "self-preview"} style={{ right: pos.right, bottom: pos.bottom }}>
      <div
        className="self-preview-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to move"
      >
        <span className="live-dot" />
        <span className="grow">{props.title}</span>
        <button type="button" onClick={toggle} title={collapsed ? "Show preview" : "Hide preview"}>
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && <div className="self-preview-body">{props.children}</div>}
    </div>
  );
}

function clamp(p: Pos, el: HTMLElement | null): Pos {
  const w = el?.offsetWidth ?? 240;
  const h = el?.offsetHeight ?? 40;
  return {
    right: Math.min(Math.max(EDGE, p.right), innerWidth - w - EDGE),
    bottom: Math.min(Math.max(EDGE, p.bottom), innerHeight - h - EDGE),
  };
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
