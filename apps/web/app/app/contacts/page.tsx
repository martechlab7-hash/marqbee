"use client";
import { useState } from "react";
import { api, timeAgo, useApi } from "@/lib/api";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, TagInput, Toggle, cx } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

interface Contact {
  id: string;
  username: string | null;
  igsid: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  source: { type?: string; keyword?: string; mediaId?: string };
  is_follower: boolean | null;
  bot_paused: boolean;
  last_inbound_at: string | null;
  created_at: string;
  account_username: string;
  window_open: boolean;
}
interface List { contacts: Contact[]; total: number; tags: { tag: string; n: number }[]; nextCursor: string | null }

const SOURCE: Record<string, string> = { comment: "Comment", dm: "DM", story_reply: "Story reply", story_mention: "Story mention" };

export default function ContactsPage() {
  const me = useMe();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, reload } = useApi<List>(`/api/contacts?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`, [q, tag]);

  return (
    <>
      <PageHeader
        title="Contacts"
        sub={data ? `${data.total} people who commented, DMed or replied to your stories.` : " "}
        action={canEdit(me) && <a href="/api/contacts/export.csv"><Button variant="secondary">Export CSV</Button></a>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input placeholder="Search name, username or email" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <button onClick={() => setTag(null)} className={cx("rounded-full px-2.5 py-1 text-xs", !tag ? "bg-ink-900 text-white" : "bg-white ring-1 ring-stone-200")}>All</button>
        {data?.tags.map((t) => (
          <button key={t.tag} onClick={() => setTag(t.tag === tag ? null : t.tag)} className={cx("rounded-full px-2.5 py-1 text-xs", tag === t.tag ? "bg-ink-900 text-white" : "bg-white ring-1 ring-stone-200")}>
            {t.tag} <span className="opacity-60">{t.n}</span>
          </button>
        ))}
      </div>
      {!data ? <div className="text-sm text-stone-500">Loading…</div> : data.contacts.length === 0 ? (
        <Empty title="No contacts yet">Contacts appear automatically when someone triggers an automation or messages you.</Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr><th className="px-4 py-2.5">Contact</th><th className="hidden px-4 py-2.5 md:table-cell">Source</th><th className="hidden px-4 py-2.5 lg:table-cell">Tags</th><th className="hidden px-4 py-2.5 sm:table-cell">Email / phone</th><th className="px-4 py-2.5">Added</th></tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.contacts.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(c.id)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">@{c.username ?? c.igsid}</div>
                    <div className="text-xs text-stone-500">{c.name ?? ""} {c.is_follower && <Badge tone="blue">follower</Badge>} {c.bot_paused && <Badge>bot paused</Badge>}</div>
                  </td>
                  <td className="hidden px-4 py-3 text-stone-600 md:table-cell">{SOURCE[c.source.type ?? ""] ?? "—"}{c.source.keyword && c.source.keyword !== "*" ? ` · “${c.source.keyword}”` : ""}</td>
                  <td className="hidden px-4 py-3 lg:table-cell"><div className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="amber">{t}</Badge>)}</div></td>
                  <td className="hidden px-4 py-3 text-stone-600 sm:table-cell">{c.email ?? c.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-stone-500">{timeAgo(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ContactDrawer id={openId} onClose={() => { setOpenId(null); void reload(); }} editable={me.workspace.role !== "viewer"} admin={canEdit(me)} />}
    </>
  );
}

function ContactDrawer({ id, onClose, editable, admin }: { id: string; onClose: () => void; editable: boolean; admin: boolean }) {
  const { data: c, setData } = useApi<Contact & { runs: { id: string; state: string; automation: string; created_at: string }[]; clicks: { url: string; ts: string }[] }>(`/api/contacts/${id}`);
  const [saving, setSaving] = useState(false);
  if (!c) return null;
  const save = async () => {
    setSaving(true);
    await api(`/api/contacts/${id}`, { method: "PATCH", body: { tags: c.tags, email: c.email || null, phone: c.phone || null, name: c.name || null, botPaused: c.bot_paused } });
    setSaving(false);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-start justify-between">
          <div><h2 className="text-lg font-semibold">@{c.username ?? c.igsid}</h2><p className="text-xs text-stone-500">via @{c.account_username} · added {timeAgo(c.created_at)}</p></div>
          <button onClick={onClose} aria-label="Close" className="text-stone-500">✕</button>
        </div>
        <div className="space-y-4">
          <Field label="Name"><Input disabled={!editable} value={c.name ?? ""} onChange={(e) => setData({ ...c, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email"><Input disabled={!editable} type="email" value={c.email ?? ""} onChange={(e) => setData({ ...c, email: e.target.value })} /></Field>
            <Field label="Phone"><Input disabled={!editable} value={c.phone ?? ""} onChange={(e) => setData({ ...c, phone: e.target.value })} /></Field>
          </div>
          <Field label="Tags"><TagInput value={c.tags} onChange={(tags) => setData({ ...c, tags })} placeholder="Add a tag" /></Field>
          <Toggle checked={c.bot_paused} onChange={(v) => setData({ ...c, bot_paused: v })} label="Pause automations for this person" />
          {editable && <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>}
        </div>
        <Card title="Automation history" className="mt-6">
          {c.runs.length ? <ul className="space-y-1.5 text-sm">{c.runs.map((r) => <li key={r.id} className="flex justify-between"><span>{r.automation ?? "Deleted automation"}</span><span className="text-xs text-stone-500">{r.state} · {timeAgo(r.created_at)}</span></li>)}</ul> : <p className="text-sm text-stone-500">None yet.</p>}
        </Card>
        <Card title="Link clicks" className="mt-4">
          {c.clicks.length ? <ul className="space-y-1.5 text-sm">{c.clicks.map((k, i) => <li key={i} className="flex justify-between gap-2"><span className="truncate">{k.url}</span><span className="flex-none text-xs text-stone-500">{timeAgo(k.ts)}</span></li>)}</ul> : <p className="text-sm text-stone-500">No clicks yet.</p>}
        </Card>
        {admin && (
          <Button variant="danger" className="mt-6" onClick={async () => { if (confirm("Permanently delete this contact and their messages?")) { await api(`/api/contacts/${id}`, { method: "DELETE" }); onClose(); } }}>
            Delete contact (data erasure request)
          </Button>
        )}
      </div>
    </div>
  );
}
