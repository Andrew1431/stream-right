import type { ReactNode } from "react";
import type { UsageResponse } from "../shared/protocol";

// Streaming usage as the web app and the desktop app both show it. Styles in usage.css.

export const DASHBOARD = "https://dash.cloudflare.com/?to=/:account/realtime/sfu";
export const PRICE_PER_GB = 0.05;

export type Usage = Extract<UsageResponse, { egressBytes: number }>;

export const gb = (bytes: number, digits = 0) =>
  (bytes / 1e9).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const dollars = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
export const overCost = (u: Usage) => (Math.max(0, u.egressBytes - u.freeBytes) / 1e9) * PRICE_PER_GB;

export function UsageBar({ used, free, label }: { used: number; free: number; label?: string }) {
  const share = used / free;
  return (
    <div
      className={`usage-bar${share >= 1 ? " over" : share >= 0.8 ? " near" : ""}`}
      role="img"
      aria-label={label ?? `${gb(used)} of ${gb(free)} free gigabytes used this month`}
    >
      <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
    </div>
  );
}

// The month's usage for a server, or why it can't be shown. `link` goes after the numbers
// (the web app links the Cloudflare dashboard; the desktop app has no browser to open it in).
export function UsageCard({ usage, link }: { usage: UsageResponse | null; link?: ReactNode }) {
  if (!usage?.configured || "error" in usage) {
    return (
      <p className="muted small usage-note">
        {usage && "error" in usage
          ? `Couldn't read usage: ${usage.error} `
          : link
            ? "See how much of the free 1,000 GB you've used: "
            : usage
              ? "This server can't read its usage: its Cloudflare analytics token isn't set."
              : "Reading this month's usage…"}
        {link}
      </p>
    );
  }

  const share = usage.egressBytes / usage.freeBytes;
  const month = new Date(usage.since + "T00:00:00Z").toLocaleString(undefined, { month: "long", timeZone: "UTC" });
  return (
    <section className="card usage">
      <div className="row spread">
        <h2>Streaming this month</h2>
        <span className="muted small">since {month} 1</span>
      </div>
      <UsageBar used={usage.egressBytes} free={usage.freeBytes} />
      <p className="small">
        <strong>{gb(usage.egressBytes)} GB</strong> <span className="muted">of {gb(usage.freeBytes)} GB free.</span>{" "}
        {share >= 1 && <span>Past the free amount: about {dollars(overCost(usage))} so far. </span>}
        {usage.limitBytes !== undefined && (
          <span>Rooms close at {gb(usage.limitBytes)} GB this month. </span>
        )}
        <span className="muted">Updated every few minutes; your Cloudflare bill is exact.</span>
      </p>
      {link}
    </section>
  );
}
