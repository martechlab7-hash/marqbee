"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi } from "@/lib/api";
import { Button, Card, ErrorNote, Field, Input, PageHeader, Select, TagInput, Textarea, Toggle, cx } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

type Kind = "comment" | "dm_keyword" | "story_reply" | "story_mention" | "welcome";
type Btn = { type: "url"; title: string; url: string };
interface Form {
  igAccountId: string;
  name: string;
  type: Kind;
  status: "active" | "paused";
  trigger: { mode: "any" | "contains" | "exact"; keywords: string[]; mediaIds: string[]; ignoreReplies: boolean };
  config: {
    publicReplies: string[];
    message: { text: string; buttons: Btn[] };
    followGate: { enabled: boolean; gateText: string; buttonTitle: string; notFollowingText: string };
    tags: string[];
  };
}

const KINDS: { k: Kind; t: string; d: string }[] = [
  { k: "comment", t: "Comment → DM", d: "Someone comments a keyword on a post or reel" },
  { k: "dm_keyword", t: "DM keyword", d: "Someone DMs you a keyword" },
  { k: "story_reply", t: "Story reply", d: "Someone replies to your story" },
  { k: "story_mention", t: "Story mention", d: "Someone mentions you in their story" },
  { k: "welcome", t: "Welcome message", d: "Someone DMs you for the first time" },
];

const blank = (accountId: string): Form => ({
  igAccountId: accountId,
  name: "",
  type: "comment",
  status: "active",
  trigger: { mode: "contains", keywords: [], mediaIds: [], ignoreReplies: true },
  config: {
    publicReplies: ["Sent you a DM 📩", "Check your DMs! ✨", "Just sent it over 🙌"],
    message: { text: "Hey {{username}}! Here's the link you asked for 👇", buttons: [{ type: "url", title: "Open link", url: "" }] },
    followGate: { enabled: false, gateText: "Almost there! Follow me first, then tap the button below 👇", buttonTitle: "I followed ✅", notFollowingText: "Hmm, I can't see your follow yet. Follow and tap again 🙏" },
    tags: [],
  },
});

interface Media { id: string; caption?: string; mediaProductType?: string; thumbnailUrl?: string; timestamp?: string }

export default function AutomationEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === "new";
  const me = useMe();
  const router = useRouter();
  const { data: accounts } = useApi<{ id: string; username: string; status: string }[]>("/api/accounts");
  const { data: existing } = useApi<Form & { trigger: Partial<Form["trigger"]>; config: Partial<Form["config"]> }>(isNew ? null : `/api/automations/${id}`);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const { data: media } = useApi<Media[]>(f?.igAccountId && f.type === "comment" ? `/api/accounts/${f.igAccountId}/media` : null, [f?.igAccountId, f?.type]);

  useEffect(() => {
    if (f) return;
    if (isNew && accounts?.length) setF(blank(accounts[0]!.id));
    if (!isNew && existing) {
      const b = blank(existing.igAccountId ?? (existing as unknown as { ig_account_id: string }).ig_account_id);
      setF({
        ...b,
        igAccountId: (existing as unknown as { ig_account_id: string }).ig_account_id,
        name: existing.name,
        type: existing.type,
        status: existing.status,
        trigger: { ...b.trigger, ...existing.trigger, mediaIds: existing.trigger.mediaIds ?? [], ignoreReplies: existing.trigger.ignoreReplies ?? true },
        config: {
          publicReplies: existing.config.publicReplies ?? [],
          message: { text: existing.config.message?.text ?? "", buttons: (existing.config.message?.buttons ?? []) as Btn[] },
          followGate: existing.config.followGate ?? { ...b.config.followGate, enabled: false },
          tags: existing.config.tags ?? [],
        },
      });
    }
  }, [accounts, existing, isNew, f]);

  if (accounts && accounts.length === 0) {
    return (
      <div className="rounded-xl border border-honey-200 bg-honey-50 p-6 text-sm">
        Connect an Instagram account first. <Link href="/app/accounts" className="font-medium underline">Go to accounts</Link>
      </div>
    );
  }
  if (!f) return <div className="text-sm text-stone-500">Loading…</div>;

  const set = (patch: (d: Form) => void) => setF((prev) => { const n = structuredClone(prev!); patch(n); return n; });
  const editable = canEdit(me);
  const isComment = f.type === "comment";
  const usesKeywords = f.type !== "welcome" && f.type !== "story_mention";

  async function save() {
    setSaving(true);
    setError(undefined);
    const body = {
      ...f!,
      trigger: { ...f!.trigger, mode: usesKeywords ? f!.trigger.mode : "any", keywords: usesKeywords ? f!.trigger.keywords : [] },
      config: {
        ...f!.config,
        publicReplies: isComment ? f!.config.publicReplies.filter((x) => x.trim()) : [],
        message: { text: f!.config.message.text, buttons: f!.config.message.buttons.filter((b) => b.title.trim() || b.url.trim()) },
        followGate: f!.config.followGate.enabled ? f!.config.followGate : undefined,
      },
    };
    try {
      if (isNew) await api("/api/automations", { body });
      else await api(`/api/automations/${id}`, { method: "PUT", body });
      router.push("/app/automations");
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={isNew ? "New automation" : f.name || "Automation"}
        sub={<Link href="/app/automations" className="hover:underline">← All automations</Link>}
        action={editable && (
          <div className="flex gap-2">
            {!isNew && <Button variant="danger" onClick={async () => { if (confirm("Delete this automation? In-progress conversations stop.")) { await api(`/api/automations/${id}`, { method: "DELETE" }); router.push("/app/automations"); } }}>Delete</Button>}
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : isNew ? "Create & go live" : "Save changes"}</Button>
          </div>
        )}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <ErrorNote error={error} />
          <Card title="1 · When this happens">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name"><Input value={f.name} onChange={(e) => set((d) => { d.name = e.target.value; })} placeholder="Chai recipe reel" /></Field>
                <Field label="Instagram account">
                  <Select value={f.igAccountId} onChange={(e) => set((d) => { d.igAccountId = e.target.value; d.trigger.mediaIds = []; })}>
                    {accounts?.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {KINDS.map((k) => (
                  <button key={k.k} type="button" onClick={() => set((d) => { d.type = k.k; })}
                    className={cx("rounded-lg border p-3 text-left text-sm transition", f.type === k.k ? "border-honey-500 bg-honey-50 ring-2 ring-honey-200" : "border-stone-200 hover:border-stone-300")}>
                    <div className="font-semibold">{k.t}</div><div className="mt-0.5 text-xs text-stone-500">{k.d}</div>
                  </button>
                ))}
              </div>

              {isComment && (
                <Field label="Which posts?" hint="Pick specific posts/reels, or leave empty to run on all posts (including future ones).">
                  <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                    {(media ?? []).map((m) => {
                      const on = f.trigger.mediaIds.includes(m.id);
                      return (
                        <button key={m.id} type="button" onClick={() => set((d) => { d.trigger.mediaIds = on ? d.trigger.mediaIds.filter((x) => x !== m.id) : [...d.trigger.mediaIds, m.id]; })}
                          className={cx("flex gap-2 rounded-lg border p-2 text-left text-xs", on ? "border-honey-500 bg-honey-50" : "border-stone-200 hover:border-stone-300")}>
                          {m.thumbnailUrl ? <img src={m.thumbnailUrl} alt="" className="h-12 w-12 flex-none rounded object-cover" /> : <div className="flex h-12 w-12 flex-none items-center justify-center rounded bg-stone-100 text-[10px] text-stone-500">{m.mediaProductType ?? "POST"}</div>}
                          <span className="line-clamp-3">{m.caption ?? m.id}</span>
                        </button>
                      );
                    })}
                    {media && media.length === 0 && <p className="text-xs text-stone-500">No posts found.</p>}
                  </div>
                  <div className="mt-1 text-xs font-medium">{f.trigger.mediaIds.length ? `${f.trigger.mediaIds.length} selected` : "All posts"}</div>
                </Field>
              )}

              {usesKeywords && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2 text-sm">
                    {(["contains", "exact", "any"] as const).map((m) => (
                      <label key={m} className={cx("cursor-pointer rounded-full border px-3 py-1", f.trigger.mode === m ? "border-ink-900 bg-ink-900 text-white" : "border-stone-300")}>
                        <input type="radio" className="sr-only" checked={f.trigger.mode === m} onChange={() => set((d) => { d.trigger.mode = m; })} />
                        {m === "contains" ? "Contains a keyword" : m === "exact" ? "Exactly matches" : `Any ${isComment ? "comment" : "message"}`}
                      </label>
                    ))}
                  </div>
                  {f.trigger.mode !== "any" && (
                    <Field label="Keywords" hint="Press Enter after each. Case, emoji and punctuation are ignored; Hindi works too.">
                      <TagInput value={f.trigger.keywords} onChange={(v) => set((d) => { d.trigger.keywords = v; })} placeholder="LINK, PRICE, लिंक" />
                    </Field>
                  )}
                </div>
              )}
            </div>
          </Card>

          {isComment && (
            <Card title="2 · Reply publicly to the comment" action={<span className="text-xs text-stone-500">Rotated so replies look human</span>}>
              <div className="space-y-2">
                {f.config.publicReplies.map((r, i) => (
                  <div key={i} className="flex gap-2">
                    <Input value={r} onChange={(e) => set((d) => { d.config.publicReplies[i] = e.target.value; })} />
                    <Button variant="ghost" onClick={() => set((d) => { d.config.publicReplies.splice(i, 1); })} aria-label="Remove">✕</Button>
                  </div>
                ))}
                {f.config.publicReplies.length < 10 && <Button variant="secondary" size="sm" onClick={() => set((d) => { d.config.publicReplies.push(""); })}>+ Add variant</Button>}
                {f.config.publicReplies.length === 0 && <p className="text-xs text-stone-500">No public reply — only the DM is sent.</p>}
              </div>
            </Card>
          )}

          <Card title={`${isComment ? "3" : "2"} · Send this DM`}>
            <div className="space-y-4">
              <Field label="Message" hint={<>Use <code>{"{{username}}"}</code> to personalise. {isComment && "Instagram allows one DM per comment until they reply — make it count."}</>}>
                <Textarea rows={4} value={f.config.message.text} onChange={(e) => set((d) => { d.config.message.text = e.target.value; })} maxLength={640} />
              </Field>
              <div className="space-y-2">
                <div className="text-sm font-medium text-ink-700">Buttons <span className="font-normal text-stone-500">(up to 3; clicks are tracked)</span></div>
                {f.config.message.buttons.map((b, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                    <Input placeholder="Button text" maxLength={20} value={b.title} onChange={(e) => set((d) => { d.config.message.buttons[i]!.title = e.target.value; })} />
                    <Input placeholder="https://…" value={b.url} onChange={(e) => set((d) => { d.config.message.buttons[i]!.url = e.target.value; })} />
                    <Button variant="ghost" onClick={() => set((d) => { d.config.message.buttons.splice(i, 1); })} aria-label="Remove button">✕</Button>
                  </div>
                ))}
                {f.config.message.buttons.length < 3 && <Button variant="secondary" size="sm" onClick={() => set((d) => { d.config.message.buttons.push({ type: "url", title: "", url: "" }); })}>+ Add button</Button>}
              </div>
            </div>
          </Card>

          <Card title="Options">
            <div className="space-y-5">
              <div>
                <Toggle checked={f.config.followGate.enabled} onChange={(v) => set((d) => { d.config.followGate.enabled = v; })} label="Ask them to follow before sending the link" />
                {f.config.followGate.enabled && (
                  <div className="mt-3 space-y-3 border-l-2 border-honey-200 pl-4">
                    <Field label="First message"><Textarea value={f.config.followGate.gateText} onChange={(e) => set((d) => { d.config.followGate.gateText = e.target.value; })} /></Field>
                    <Field label="Button text"><Input maxLength={20} value={f.config.followGate.buttonTitle} onChange={(e) => set((d) => { d.config.followGate.buttonTitle = e.target.value; })} /></Field>
                    <Field label="If they haven't followed yet"><Textarea value={f.config.followGate.notFollowingText} onChange={(e) => set((d) => { d.config.followGate.notFollowingText = e.target.value; })} /></Field>
                  </div>
                )}
              </div>
              <Field label="Tag contacts" hint="Added to everyone this automation reaches — use them to segment later.">
                <TagInput value={f.config.tags} onChange={(v) => set((d) => { d.config.tags = v; })} placeholder="chai-recipe, diwali" />
              </Field>
              {isComment && <Toggle checked={f.trigger.ignoreReplies} onChange={(v) => set((d) => { d.trigger.ignoreReplies = v; })} label="Ignore replies inside comment threads" />}
            </div>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-[28px] border-8 border-ink-900 bg-white p-3 shadow-lg">
            <div className="mb-3 text-center text-xs font-semibold text-stone-500">DM preview</div>
            <div className="space-y-2">
              {f.config.followGate.enabled && (
                <Bubble text={f.config.followGate.gateText} buttons={[f.config.followGate.buttonTitle]} />
              )}
              <Bubble text={f.config.message.text.replace(/\{\{\s*username\s*\}\}/g, "priya_cooks")} buttons={f.config.message.buttons.map((b) => b.title || "Button")} />
            </div>
          </div>
          <p className="mt-3 text-xs text-stone-500">Instagram rules applied automatically: one DM per comment, follow-ups only within 24h of their last message, and sending paced to stay under Meta&apos;s rate limits.</p>
        </aside>
      </div>
    </>
  );
}

function Bubble({ text, buttons }: { text: string; buttons: string[] }) {
  return (
    <div className="max-w-[90%] overflow-hidden rounded-2xl bg-stone-100 text-sm">
      <p className="whitespace-pre-wrap px-3 py-2">{text || "…"}</p>
      {buttons.map((b, i) => <div key={i} className="border-t border-stone-200 py-2 text-center font-semibold text-sky-600">{b}</div>)}
    </div>
  );
}
