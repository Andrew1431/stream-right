import { useEffect, type ReactNode } from "react";

export function Sheet(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <section className={props.wide ? "sheet wide" : "sheet"} role="dialog" aria-label={props.title}>
        <header className="row spread">
          <h2>{props.title}</h2>
          <button type="button" className="quiet" onClick={props.onClose}>Close</button>
        </header>
        {props.children}
      </section>
    </div>
  );
}
