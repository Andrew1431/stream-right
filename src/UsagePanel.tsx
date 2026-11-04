import { useEffect, useState } from "react";
import type { UsageResponse } from "../shared/protocol";
import { DASHBOARD, PRICE_PER_GB, UsageBar, dollars, gb, overCost, type Usage } from "../ui/usage";
import type { Subscriber } from "./media";

const REFRESH_MS = 60_000;
const RATE_SAMPLE_MS = 2_000;

// Polls /api/usage while `active`. Null until a usable answer arrives (no token, bad key, or an API error).
export function useUsage(creatorKey: string, active = true): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    if (!creatorKey || !active) return;
    let stopped = false;
    const poll = () =>
      fetch("/api/usage", { headers: { Authorization: `Bearer ${creatorKey}` } })
        .then((r) => (r.ok ? (r.json() as Promise<UsageResponse>) : null))
        .then((u) => !stopped && setUsage(u && "egressBytes" in u ? u : null))
        .catch(() => {});
    poll();
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [creatorKey, active]);
  return usage;
}

// Bytes per second this browser is pulling from the SFU.
function useReceiveRate(subscriber: Subscriber | null): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!subscriber) return;
    let last: { at: number; bytes: number } | null = null;
    const sample = async () => {
      const bytes = await subscriber.bytesReceived().catch(() => null);
      if (bytes === null) return;
      const at = performance.now();
      if (last && bytes >= last.bytes) setRate(((bytes - last.bytes) * 1000) / (at - last.at));
      last = { at, bytes };
    };
    sample();
    const id = setInterval(sample, RATE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [subscriber]);
  return rate;
}

function hours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  return `${Math.round(h).toLocaleString()} hour${Math.round(h) === 1 ? "" : "s"}`;
}

export function UsagePanel(props: { usage: Usage; subscriber: Subscriber | null; onClose: () => void }) {
  const { usage } = props;
  const receive = useReceiveRate(props.subscriber);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const used = usage.egressBytes;
  const free = usage.freeBytes;
  const left = Math.max(0, free - used);
  const perHour = usage.lastHourBytes;
  const over = used >= free;
  const costPerHour = (perHour / 1e9) * PRICE_PER_GB;

  return (
    <aside className="card usage-panel" aria-label="Streaming usage">
      <div className="row spread">
        <h2>Usage</h2>
        <button type="button" className="link small" onClick={props.onClose}>Close</button>
      </div>

      <UsageBar used={used} free={free} />
      <p className="small">
        <strong>{gb(used, used < 10e9 ? 1 : 0)} GB</strong> <span className="muted">of {gb(free)} GB free this month</span>
      </p>

      <dl className="usage-stats small">
        <dt>Last hour</dt>
        <dd>
          {gb(perHour, 1)} GB
          <span className="muted"> · {((perHour / free) * 100).toFixed(2)}% of the free amount</span>
        </dd>

        <dt>{over ? "Cost now" : "Cost after free"}</dt>
        <dd>
          {dollars(costPerHour)} an hour
          {over && <span className="muted"> · {dollars(overCost(usage))} so far this month</span>}
        </dd>

        {!over && (
          <>
            <dt>Free amount lasts</dt>
            <dd>{perHour > 0 ? `${hours(left / perHour)} of streaming like the last hour` : `${gb(left)} GB left`}</dd>
          </>
        )}

        <dt>You're receiving</dt>
        <dd>
          {receive === null ? (
            <span className="muted">Measuring…</span>
          ) : (
            <>
              {((receive * 8) / 1e6).toFixed(1)} Mbps
              <span className="muted"> · {gb(receive * 3600, 1)} GB an hour</span>
            </>
          )}
        </dd>
      </dl>

      <p className="muted small">
        Whole account, from Cloudflare's analytics; a minute or two behind. Your upload is free.{" "}
        <a className="link" href={DASHBOARD} target="_blank" rel="noreferrer">Dashboard</a>
      </p>
    </aside>
  );
}
