import type { UsageResponse } from "../shared/protocol";

// Optional secrets, so they're not in .dev.vars.example (the Deploy button would ask for them).
type UsageEnv = { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string; USAGE_LIMIT_GB?: string };

// The owner's monthly cap in bytes, or undefined for none. "free" means stay inside the free
// allowance, with a margin because Cloudflare's numbers trail real traffic by a few minutes.
export function usageLimit(workerEnv: Env): number | undefined {
  const raw = ((workerEnv as Env & UsageEnv).USAGE_LIMIT_GB ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "free") return FREE_BYTES * 0.95;
  const gb = Number(raw);
  return Number.isFinite(gb) && gb > 0 ? gb * 1e9 : undefined;
}

// Whether rooms should stop streaming. Errs open: an analytics outage shouldn't end everyone's stream.
export async function overLimit(env: Env): Promise<boolean> {
  const limit = usageLimit(env);
  if (limit === undefined) return false;
  const usage = await getUsage(env);
  if (!usage.configured) return false;
  if ("error" in usage) {
    console.error("usage limit: can't read usage", usage.error);
    return false;
  }
  return usage.egressBytes >= limit;
}

// Realtime's free allowance is per account per month, shared by SFU and TURN.
const FREE_BYTES = 1000e9;
const CACHE_MS = 60_000;
const API = "https://api.cloudflare.com/client/v4";

let cached: { at: number; body: UsageResponse } | undefined;
let accountId: string | undefined;

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await res.json()) as { result?: unknown; data?: unknown; errors?: { message: string }[] | null };
  if (!res.ok || body.errors?.length) throw new Error(body.errors?.[0]?.message ?? `Cloudflare API ${res.status}`);
  return (body.result ?? body.data) as T;
}

async function findAccount(token: string): Promise<string> {
  const accounts = await cf<{ id: string }[]>(token, "/accounts");
  if (accounts.length !== 1) throw new Error("Set CF_ACCOUNT_ID: the token can see more than one account, or none.");
  return accounts[0].id;
}

type Groups = { sum: { egressBytes: number } }[];

export async function getUsage(workerEnv: Env): Promise<UsageResponse> {
  const env = workerEnv as Env & UsageEnv;
  const token = env.CF_API_TOKEN;
  if (!token) return { configured: false };
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;

  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  let body: UsageResponse;
  try {
    accountId ??= env.CF_ACCOUNT_ID || (await findAccount(token));
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString().slice(0, 19) + "Z";
    const query = `query($account: String!, $since: Date!, $hourAgo: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        sfu: callsUsageAdaptiveGroups(limit: 1, filter: { date_geq: $since }) { sum { egressBytes } }
        turn: callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $since }) { sum { egressBytes } }
        sfuHour: callsUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $hourAgo }) { sum { egressBytes } }
        turnHour: callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $hourAgo }) { sum { egressBytes } }
      } }
    }`;
    type Account = Record<"sfu" | "turn" | "sfuHour" | "turnHour", Groups>;
    const data = await cf<{ viewer: { accounts: Account[] } }>(token, "/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables: { account: accountId, since, hourAgo } }),
    });
    const account = data.viewer.accounts[0];
    const total = (g?: Groups) => g?.reduce((n, x) => n + x.sum.egressBytes, 0) ?? 0;
    body = {
      configured: true,
      egressBytes: total(account?.sfu) + total(account?.turn),
      lastHourBytes: total(account?.sfuHour) + total(account?.turnHour),
      freeBytes: FREE_BYTES,
      since,
      limitBytes: usageLimit(env),
    };
  } catch (e) {
    accountId = undefined;
    body = { configured: true, error: e instanceof Error ? e.message : String(e) };
  }
  cached = { at: Date.now(), body };
  return body;
}
