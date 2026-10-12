"use client";
import { useEffect, useState } from "react";
import { api, useApi } from "@/lib/api";
import { BioPageView, THEMES, type BioBlock, type BioPageData } from "@/components/bio-render";
import { Button, Card, ErrorNote, Field, Input, PageHeader, Select, Textarea, Toggle, cx } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

type Page = BioPageData & { id: string; published: boolean; plan: string };

const NEW_BLOCK: Record<BioBlock["type"], BioBlock> = {
  link: { type: "link", enabled: true, data: { title: "New link", url: "https://" } },
  header: { type: "header", enabled: true, data: { text: "Section" } },
  text: { type: "text", enabled: true, data: { text: "A few words about this." } },
  youtube: { type: "youtube", enabled: true, data: { url: "https://youtu.be/" } },
  spotify: { type: "spotify", enabled: true, data: { url: "https://open.spotify.com/track/" } },
  socials: { type: "socials", enabled: true, data: { links: [{ network: "instagram", url: "https://instagram.com/" }] } },
};

export default function BioEditor() {
  const me = useMe();
  const { data } = useApi<Page>("/api/bio");
  const [p, setP] = useState<Page | null>(null);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data && !p) setP(data); }, [data, p]);
  if (!p) return <div className="text-sm text-stone-500">Loading…</div>;

  const editable = canEdit(me);
  const upd = (patch: Partial<Page>) => { setP({ ...p, ...patch }); setSaved(false); };
  const updBlock = (i: number, b: BioBlock) => upd({ blocks: p.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, d: -1 | 1) => {
    const blocks = [...p.blocks];
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
    upd({ blocks });
  };
  const publicUrl = typeof window !== "undefined" ? `${window.location.origin}/${p.slug}` : `/${p.slug}`;

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const r = await api<{ slug: string; blocks: BioBlock[] }>("/api/bio", {
        method: "PUT",
        body: { slug: p!.slug, title: p!.title, bio: p!.bio, avatarUrl: p!.avatar_url || null, theme: p!.theme, showBadge: p!.show_badge, published: p!.published, blocks: p!.blocks },
      });
      setP({ ...p!, slug: r.slug, blocks: r.blocks });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Bio page"
        sub={<>Live at <a className="font-medium text-ink-900 underline" href={`/${p.slug}`} target="_blank" rel="noreferrer">{publicUrl.replace(/^https?:\/\//, "")}</a></>}
        action={editable && <div className="flex items-center gap-3">{saved && <span className="text-sm text-emerald-600">Saved</span>}<Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save & publish"}</Button></div>}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <ErrorNote error={error} />
          <Card title="Profile">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Page URL" hint="Letters, numbers, dots, dashes."><div className="flex items-center rounded-lg border border-stone-300 bg-stone-50 pl-3 text-sm text-stone-500">/<Input className="rounded-l-none border-0 border-l" value={p.slug} onChange={(e) => upd({ slug: e.target.value })} /></div></Field>
                <Field label="Title"><Input value={p.title} onChange={(e) => upd({ title: e.target.value })} /></Field>
              </div>
              <Field label="Bio"><Textarea value={p.bio} maxLength={300} onChange={(e) => upd({ bio: e.target.value })} /></Field>
              <Field label="Avatar image URL"><Input value={p.avatar_url ?? ""} placeholder="https://…" onChange={(e) => upd({ avatar_url: e.target.value })} /></Field>
            </div>
          </Card>
          <Card title="Theme">
            <div className="flex flex-wrap gap-3">
              {Object.entries(THEMES).map(([k, t]) => (
                <button key={k} onClick={() => upd({ theme: { ...p.theme, preset: k } })} className={cx("h-16 w-24 rounded-lg border-2 text-xs font-semibold capitalize", p.theme.preset === k ? "border-ink-900" : "border-transparent ring-1 ring-stone-200")} style={{ background: t.bg, color: t.text }}>{k}</button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-6">
              <Field label="Buttons">
                <Select value={p.theme.buttonStyle ?? "pill"} onChange={(e) => upd({ theme: { ...p.theme, buttonStyle: e.target.value as "pill" } })} className="w-36">
                  <option value="pill">Pill</option><option value="rounded">Rounded</option><option value="square">Square</option>
                </Select>
              </Field>
              <div className="space-y-2 pt-5">
                <Toggle checked={p.published} onChange={(v) => upd({ published: v })} label="Published" />
                <div title={p.plan === "free" ? "Upgrade to Creator Pro to remove the badge" : undefined}>
                  <Toggle checked={p.plan === "free" ? true : p.show_badge} onChange={(v) => p.plan !== "free" && upd({ show_badge: v })} label={`“Made with Marqbee” badge${p.plan === "free" ? " (Pro removes it)" : ""}`} />
                </div>
              </div>
            </div>
          </Card>
          <Card title="Blocks" action={
            <Select className="w-40" value="" onChange={(e) => { if (e.target.value) upd({ blocks: [...p.blocks, structuredClone(NEW_BLOCK[e.target.value as BioBlock["type"]])] }); }}>
              <option value="">+ Add block</option><option value="link">Link</option><option value="header">Header</option><option value="text">Text</option><option value="youtube">YouTube video</option><option value="spotify">Spotify</option><option value="socials">Social icons</option>
            </Select>
          }>
            <div className="space-y-3">
              {p.blocks.length === 0 && <p className="text-sm text-stone-500">Add your first link — shop, latest video, WhatsApp group…</p>}
              {p.blocks.map((b, i) => (
                <div key={b.id ?? `new-${i}`} className={cx("rounded-lg border border-stone-200 p-3", b.enabled === false && "opacity-60")}>
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="font-semibold uppercase tracking-wide text-stone-500">{b.type}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Toggle checked={b.enabled !== false} onChange={(v) => updBlock(i, { ...b, enabled: v })} />
                      <Button size="sm" variant="ghost" onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                      <Button size="sm" variant="ghost" onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                      <Button size="sm" variant="ghost" onClick={() => upd({ blocks: p.blocks.filter((_, j) => j !== i) })} aria-label="Remove">✕</Button>
                    </div>
                  </div>
                  <BlockFields block={b} onChange={(nb) => updBlock(i, nb)} />
                </div>
              ))}
            </div>
          </Card>
        </div>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="h-[680px] overflow-hidden rounded-[36px] border-[10px] border-ink-900 shadow-xl">
            <div className="h-full overflow-y-auto"><BioPageView page={{ ...p, show_badge: p.plan === "free" ? true : p.show_badge }} preview /></div>
          </div>
        </aside>
      </div>
    </>
  );
}

function BlockFields({ block: b, onChange }: { block: BioBlock; onChange: (b: BioBlock) => void }) {
  switch (b.type) {
    case "link":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Title" value={b.data.title} onChange={(e) => onChange({ ...b, data: { ...b.data, title: e.target.value } })} />
          <Input placeholder="https://" value={b.data.url} onChange={(e) => onChange({ ...b, data: { ...b.data, url: e.target.value } })} />
          <Input placeholder="Thumbnail URL (optional)" value={b.data.thumbnail ?? ""} onChange={(e) => onChange({ ...b, data: { ...b.data, thumbnail: e.target.value || undefined } })} />
          <Input placeholder="utm_campaign (optional)" value={b.data.utm?.utm_campaign ?? ""} onChange={(e) => onChange({ ...b, data: { ...b.data, utm: e.target.value ? { utm_source: "instagram", utm_medium: "bio", utm_campaign: e.target.value } : undefined } })} />
          <Toggle checked={!!b.data.highlight} onChange={(v) => onChange({ ...b, data: { ...b.data, highlight: v } })} label="Highlight" />
        </div>
      );
    case "header":
    case "text":
      return <Input value={b.data.text} onChange={(e) => onChange({ ...b, data: { text: e.target.value } })} />;
    case "youtube":
    case "spotify":
      return <Input placeholder="Paste link" value={b.data.url} onChange={(e) => onChange({ ...b, data: { url: e.target.value } })} />;
    case "socials":
      return (
        <div className="space-y-2">
          {b.data.links.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Select className="w-36" value={l.network} onChange={(e) => onChange({ ...b, data: { links: b.data.links.map((x, j) => (j === i ? { ...x, network: e.target.value } : x)) } })}>
                {["instagram", "youtube", "x", "threads", "linkedin", "whatsapp", "email", "website"].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
              <Input value={l.url} onChange={(e) => onChange({ ...b, data: { links: b.data.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) } })} />
              <Button variant="ghost" onClick={() => onChange({ ...b, data: { links: b.data.links.filter((_, j) => j !== i) } })}>✕</Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => onChange({ ...b, data: { links: [...b.data.links, { network: "youtube", url: "https://" }] } })}>+ Add</Button>
        </div>
      );
  }
}
