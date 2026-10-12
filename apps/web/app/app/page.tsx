"use client";
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/api";
import { Card, Empty, PageHeader, Select, Stat } from "@/components/ui";

interface Overview {
  days: number;
  totals: Record<string, number>;
  daily: { day: string; dms: number; clicks: number; contacts: number }[];
  topKeywords: { keyword: string; comments: number }[];
  topPosts: { media_id: string; comments: number; clickers: number }[];
  topLinks: { id: string; title: string; clicks: number }[];
  funnel: { comments: number; dms: number; clicks: number };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

function Bars({ data }: { data: Overview["daily"] }) {
  const max = Math.max(1, ...data.map((d) => d.dms));
  return (
    <div>
      <div className="flex h-36 items-end gap-[3px]">
        {data.map((d) => (
          <div key={d.day} className="group relative flex-1">
            <div className="w-full rounded-t-sm bg-honey-400 transition group-hover:bg-honey-500" style={{ height: `${Math.max(2, (d.dms / max) * 140)}px` }} />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink-900 px-2 py-1 text-xs text-white group-hover:block">
              {d.day}: {d.dms} DMs · {d.clicks} clicks · {d.contacts} new contacts
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-stone-400"><span>{data[0]?.day}</span><span>{data.at(-1)?.day}</span></div>
    </div>
  );
}

export default function OverviewPage() {
  const [days, setDays] = useState(30);
  const { data, loading } = useApi<Overview>(`/api/analytics/overview?days=${days}`, [days]);
  const { data: accounts } = useApi<{ id: string }[]>("/api/accounts");

  return (
    <>
      <PageHeader
        title="Overview"
        sub="What your automations did, and what people did next."
        action={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      {accounts && accounts.length === 0 && (
        <div className="mb-6 rounded-xl border border-honey-200 bg-honey-50 p-4 text-sm">
          <strong>Start here:</strong> <Link href="/app/accounts" className="underline">connect your Instagram professional account</Link>, then create your first comment-to-DM automation.
        </div>
      )}
      {loading && !data ? (
        <div className="text-sm text-stone-500">Loading…</div>
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="DMs sent" value={data.totals.dms_sent} sub={data.totals.queued ? `${data.totals.queued} queued` : `${data.totals.not_delivered} not delivered`} />
            <Stat label="Comments answered" value={data.totals.comments_triggered} sub={`${data.totals.public_replies} public replies`} />
            <Stat label="DM link click rate" value={pct(data.totals.dm_unique_clickers!, data.totals.dms_sent!)} sub={`${data.totals.dm_link_clicks} clicks`} />
            <Stat label="New contacts" value={data.totals.new_contacts} sub={`${data.totals.total_contacts} total`} />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="DMs sent per day" className="lg:col-span-2">{data.daily.length ? <Bars data={data.daily} /> : null}</Card>
            <Card title="Funnel">
              <ol className="space-y-3 text-sm">
                {[
                  ["Comments matched", data.funnel.comments, null],
                  ["DMs delivered", data.funnel.dms, pct(data.funnel.dms, data.funnel.comments)],
                  ["Clicked a link", data.funnel.clicks, pct(data.funnel.clicks, data.funnel.dms)],
                ].map(([l, n, p]) => (
                  <li key={l as string}>
                    <div className="flex justify-between"><span>{l}</span><span className="font-semibold tabular-nums">{n as number}{p ? <span className="ml-1.5 text-xs font-normal text-stone-500">{p}</span> : null}</span></div>
                    <div className="mt-1 h-1.5 rounded-full bg-stone-100"><div className="h-1.5 rounded-full bg-honey-500" style={{ width: pct(n as number, data.funnel.comments || 1) === "—" ? "0%" : `${Math.min(100, ((n as number) / Math.max(1, data.funnel.comments)) * 100)}%` }} /></div>
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-xs text-stone-500">Revenue per reel arrives with Shopify/Razorpay attribution.</p>
            </Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Top keywords">
              {data.topKeywords.length ? (
                <ul className="space-y-2 text-sm">{data.topKeywords.map((k) => <li key={k.keyword} className="flex justify-between"><span className="font-medium">{k.keyword === "*" ? "Any comment" : k.keyword}</span><span className="tabular-nums text-stone-600">{k.comments}</span></li>)}</ul>
              ) : <p className="text-sm text-stone-500">No comments matched yet.</p>}
            </Card>
            <Card title="Top posts">
              {data.topPosts.length ? (
                <ul className="space-y-2 text-sm">{data.topPosts.map((p) => <li key={p.media_id} className="flex justify-between gap-2"><span className="truncate font-mono text-xs">{p.media_id}</span><span className="whitespace-nowrap tabular-nums text-stone-600">{p.comments} · {pct(p.clickers, p.comments)} clicked</span></li>)}</ul>
              ) : <p className="text-sm text-stone-500">No post activity yet.</p>}
            </Card>
            <Card title="Bio page">
              <div className="mb-3 flex gap-6 text-sm"><div><div className="text-xl font-semibold">{data.totals.bio_views}</div><div className="text-xs text-stone-500">views</div></div><div><div className="text-xl font-semibold">{data.totals.bio_clicks}</div><div className="text-xs text-stone-500">clicks · {pct(data.totals.bio_clicks!, data.totals.bio_views!)} CTR</div></div></div>
              {data.topLinks.length ? <ul className="space-y-1.5 text-sm">{data.topLinks.slice(0, 5).map((l) => <li key={l.id} className="flex justify-between"><span className="truncate">{l.title}</span><span className="tabular-nums text-stone-600">{l.clicks}</span></li>)}</ul> : <Link href="/app/bio" className="text-sm underline">Set up your bio page</Link>}
            </Card>
          </div>
        </div>
      ) : (
        <Empty title="Couldn't load analytics" />
      )}
    </>
  );
}
