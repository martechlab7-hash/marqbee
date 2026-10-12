"use client";
import { useState } from "react";
import { api, timeAgo, useApi } from "@/lib/api";
import { Badge, Button, Card, ErrorNote, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

export default function TeamPage() {
  const me = useMe();
  const admin = canEdit(me);
  const { data: team, reload } = useApi<{ id: string; email: string; name: string | null; role: string }[]>("/api/team");
  const { data: replies, reload: reloadReplies } = useApi<{ id: string; title: string; body: string }[]>("/api/saved-replies");
  const { data: audit } = useApi<{ action: string; entity: string; ts: string; email: string }[]>(admin ? "/api/audit-log" : null);
  const { data: failed } = useApi<{ id: number; reason: string; error_code: string | null; created_at: string; body: string | null; username: string | null }[]>("/api/deliveries/failed");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("agent");
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState({ title: "", body: "" });

  return (
    <>
      <PageHeader title="Team & settings" sub="Members, saved replies, delivery issues and the audit log." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Members">
          <ul className="divide-y divide-stone-100 text-sm">
            {team?.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2">
                <div><div className="font-medium">{m.name ?? m.email}</div><div className="text-xs text-stone-500">{m.email}</div></div>
                <div className="flex items-center gap-2"><Badge tone={m.role === "owner" ? "amber" : "stone"}>{m.role}</Badge>
                  {admin && m.role !== "owner" && m.id !== me.user.id && <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/team/${m.id}`, { method: "DELETE" }); void reload(); }}>Remove</Button>}
                </div>
              </li>
            ))}
          </ul>
          {admin && (
            <form className="mt-4 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); setError(undefined); try { await api("/api/team", { body: { email, role } }); setEmail(""); void reload(); } catch (err) { setError((err as Error).message); } }}>
              <Input className="min-w-48 flex-1" type="email" placeholder="teammate@brand.in" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <Select className="w-32" value={role} onChange={(e) => setRole(e.target.value)}><option value="admin">Admin</option><option value="agent">Agent</option><option value="viewer">Viewer</option></Select>
              <Button>Add</Button>
            </form>
          )}
          <ErrorNote error={error} />
          <p className="mt-3 text-xs text-stone-500">Admins manage automations and accounts. Agents work the inbox and contacts. Viewers see everything, change nothing.</p>
        </Card>
        <Card title="Saved replies">
          <ul className="space-y-2 text-sm">
            {replies?.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-2 rounded-lg bg-stone-50 p-2">
                <div><div className="font-medium">{r.title}</div><div className="text-xs text-stone-600">{r.body}</div></div>
                {me.workspace.role !== "viewer" && <button className="text-xs text-stone-500" onClick={async () => { await api(`/api/saved-replies/${r.id}`, { method: "DELETE" }); void reloadReplies(); }}>✕</button>}
              </li>
            ))}
          </ul>
          {me.workspace.role !== "viewer" && (
            <form className="mt-3 space-y-2" onSubmit={async (e) => { e.preventDefault(); await api("/api/saved-replies", { body: reply }); setReply({ title: "", body: "" }); void reloadReplies(); }}>
              <Input placeholder="Title (e.g. Shipping)" value={reply.title} onChange={(e) => setReply({ ...reply, title: e.target.value })} required />
              <Textarea placeholder="We ship across India in 3–5 days 🚚" value={reply.body} onChange={(e) => setReply({ ...reply, body: e.target.value })} required />
              <Button size="sm">Add saved reply</Button>
            </form>
          )}
        </Card>
        <Card title="Messages not delivered">
          {failed?.length ? (
            <ul className="space-y-1.5 text-sm">{failed.slice(0, 15).map((f) => <li key={f.id} className="flex justify-between gap-2"><span className="truncate">@{f.username ?? "?"}: {f.body}</span><span className="flex-none text-xs text-stone-500">{f.reason.replace(/_/g, " ")} · {timeAgo(f.created_at)}</span></li>)}</ul>
          ) : <p className="text-sm text-stone-500">Nothing failed. 🎉</p>}
          <p className="mt-3 text-xs text-stone-500">Common reasons: the 24h window closed before a follow-up, the comment was deleted, or the person blocked messages.</p>
        </Card>
        {admin && (
          <Card title="Audit log">
            <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">{audit?.map((a, i) => <li key={i} className="flex justify-between gap-2"><span>{a.email} <span className="text-stone-500">{a.action.replace(/_/g, " ")} · {a.entity.replace(/_/g, " ")}</span></span><span className="flex-none text-xs text-stone-500">{timeAgo(a.ts)}</span></li>)}</ul>
          </Card>
        )}
      </div>
    </>
  );
}
