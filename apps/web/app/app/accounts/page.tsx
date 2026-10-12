"use client";
import { useEffect, useState } from "react";
import { api, fmtDuration, timeAgo, useApi } from "@/lib/api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, PageHeader, Select, Toggle } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

interface Account {
  id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  status: "active" | "needs_reconnect";
  token_expires_at: string | null;
  queued: number;
  queueEtaMs: number;
}

const ERRORS: Record<string, string> = {
  not_professional: "That account is a personal account. Switch it to a Creator or Business account in Instagram settings, then try again.",
  expired_state: "The connection took too long. Please try again.",
  oauth_failed: "Instagram didn't complete the connection. Please try again.",
  cancelled: "Connection cancelled.",
};

export default function AccountsPage() {
  const me = useMe();
  const { data, reload } = useApi<Account[]>("/api/accounts");
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setNotice({ ok: true, text: "Instagram account connected. Comments and DMs will now flow in." });
    else if (q.get("error")) setNotice({ ok: false, text: ERRORS[q.get("error")!] ?? "Something went wrong." });
  }, []);

  const connect = async () => {
    const { url } = await api<{ url: string }>("/api/accounts/connect");
    window.location.href = url;
  };

  return (
    <>
      <PageHeader title="Instagram accounts" sub="Connected through Meta's official Instagram API — we never ask for your password."
        action={canEdit(me) && me.metaMode === "live" && <Button onClick={connect}>Connect Instagram</Button>} />
      {notice && <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${notice.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"}`}>{notice.text}</div>}
      {data && data.length === 0 && (
        <Empty title="No accounts connected">
          You need an Instagram <strong>Creator</strong> or <strong>Business</strong> account. Personal accounts can switch for free in Instagram → Settings → Account type and tools.
        </Empty>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {data?.map((a) => (
          <Card key={a.id}>
            <div className="flex items-center gap-3">
              {a.profile_picture_url ? <img src={a.profile_picture_url} alt="" className="h-12 w-12 rounded-full" /> : <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-honey-400 to-pink-500 font-bold text-white">{a.username[0]?.toUpperCase()}</div>}
              <div className="min-w-0 flex-1">
                <div className="font-semibold">@{a.username}</div>
                <div className="text-xs text-stone-500">{a.account_type?.toLowerCase().replace("media_", "") ?? "professional"} account</div>
              </div>
              {a.status === "active" ? <Badge tone="green">Connected</Badge> : <Badge tone="red">Needs reconnect</Badge>}
            </div>
            {a.queued > 0 && (
              <div className="mt-3 rounded-lg bg-honey-50 px-3 py-2 text-sm text-honey-700">
                <strong>{a.queued}</strong> DMs queued — sending {fmtDuration(a.queueEtaMs)} at Instagram&apos;s safe rate.
              </div>
            )}
            {a.status === "needs_reconnect" && <p className="mt-3 text-sm text-red-700">Instagram rejected our access token. Reconnect to resume automations.</p>}
            <div className="mt-4 flex items-center justify-between text-xs text-stone-500">
              <span>Token renews automatically{a.token_expires_at ? ` · expires ${timeAgo(a.token_expires_at).replace(" ago", "")}` : ""}</span>
              {canEdit(me) && (
                <div className="flex gap-2">
                  {a.status === "needs_reconnect" && me.metaMode === "live" && <Button size="sm" onClick={connect}>Reconnect</Button>}
                  <Button size="sm" variant="danger" onClick={async () => { if (confirm(`Disconnect @${a.username}? Its automations will be paused.`)) { await api(`/api/accounts/${a.id}`, { method: "DELETE" }); void reload(); } }}>Disconnect</Button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {me.metaMode === "fake" && canEdit(me) && <DevTools accounts={data ?? []} onChange={reload} />}
    </>
  );
}

/** Local development: no Meta app needed. Connect a fake account and fire signed webhooks through the real pipeline. */
function DevTools({ accounts, onChange }: { accounts: Account[]; onChange: () => void }) {
  const [username, setUsername] = useState("masala_mom");
  const [sim, setSim] = useState({ accountId: "", kind: "comment", fromUsername: "priya_cooks", text: "LINK please!", follows: false });
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const { data: outbox, reload } = useApi<{ method: string; args: unknown[] }[]>("/api/dev/outbox");
  useEffect(() => { if (!sim.accountId && accounts[0]) setSim((s) => ({ ...s, accountId: accounts[0]!.id })); }, [accounts, sim.accountId]);
  useEffect(() => { const t = setInterval(() => void reload(), 2000); return () => clearInterval(t); }, [reload]);

  return (
    <div className="mt-10 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Developer tools (META_CLIENT=fake)</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connect a simulated account">
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); setError(undefined); try { await api("/api/dev/connect-account", { body: { username } }); onChange(); } catch (err) { setError((err as Error).message); } }}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} /><Button>Connect</Button>
          </form>
        </Card>
        <Card title="Simulate an Instagram event">
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault(); setError(undefined);
            try { const r = await api<{ accepted: number }>("/api/dev/simulate", { body: sim }); setResult(`Webhook accepted (${r.accepted} event). Check Inbox and the outbox below.`); } catch (err) { setError((err as Error).message); }
          }}>
            <div className="grid grid-cols-2 gap-2">
              <Select value={sim.accountId} onChange={(e) => setSim({ ...sim, accountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}</Select>
              <Select value={sim.kind} onChange={(e) => setSim({ ...sim, kind: e.target.value })}>
                <option value="comment">Comment on reel</option><option value="dm">Direct message</option><option value="story_mention">Story mention</option><option value="follow_tap">Taps “I followed”</option>
              </Select>
            </div>
            <Field label="From"><Input value={sim.fromUsername} onChange={(e) => setSim({ ...sim, fromUsername: e.target.value })} /></Field>
            {(sim.kind === "comment" || sim.kind === "dm") && <Field label="Text"><Input value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} /></Field>}
            <Toggle checked={sim.follows} onChange={(v) => setSim({ ...sim, follows: v })} label="This person follows the account" />
            <ErrorNote error={error} />
            {result && <p className="text-xs text-emerald-700">{result}</p>}
            <Button disabled={!sim.accountId}>Send webhook</Button>
          </form>
        </Card>
      </div>
      <Card title="Outbox — calls that would go to Meta">
        {outbox?.length ? (
          <ul className="space-y-2 font-mono text-xs">{outbox.map((c, i) => <li key={i} className="rounded bg-stone-50 p-2"><span className="font-semibold text-honey-700">{c.method}</span> {JSON.stringify(c.args)}</li>)}</ul>
        ) : <p className="text-sm text-stone-500">Nothing sent yet.</p>}
      </Card>
    </div>
  );
}
