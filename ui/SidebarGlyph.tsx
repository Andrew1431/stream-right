// The panel icon on the sidebar toggle, shared by the desktop shell and the room bar it embeds.
export function SidebarGlyph({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M8 3.5v13" />
      {open ? (
        <path d="M5.5 7.5h0M5.5 10h0" strokeLinecap="round" strokeWidth="1.8" />
      ) : (
        <path d="M11 8l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
