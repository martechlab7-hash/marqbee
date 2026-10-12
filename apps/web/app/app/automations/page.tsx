"use client";
import Link from "next/link";
import { api, timeAgo, useApi } from "@/lib/api";
import { Badge, Button, Empty, PageHeader, Toggle } from "@/components/ui";
import { canEdit, useMe } from "@/components/session";

interface Automation {
  id: string;
  name: string;
  type: string;
  status: "active" | "paused";
  trigger: { mode: string; keywords: string[]; mediaIds?: string[] };
  account_username: string;
  runs: number;
  dms_sent: number;
  clicks: number;
  updated_at: string;
}

const TYPE_LABEL: Record<string, string> = {
  comment: "Comment → DM",
  dm_keyword: "DM keyword",
  story_reply: "Story reply",
  story_mention: "Story mention",
  welcome: "Welcome message",
};

function triggerSummary(a: Automation) {
  const where = a.type === "comment" ? (a.trigger.mediaIds?.length ? `${a.trigger.mediaIds.length} post(s)` : "all posts") : "";
  const what = a.trigger.mode === "any" ? "any message" : a.trigger.keywords.map((k) => `“${k}”`).join(", ");
  return [what, where].filter(Boolean).join(" · ");
}

export default function AutomationsPage() {
  const me = useMe();
  const { data, reload } = useApi<Automation[]>("/api/automations");
  return (
    <>
      <PageHeader
        title="Automations"
        sub="Reply to comments, DMs and story interactions automatically — always inside Instagram's rules."
        action={canEdit(me) && <Link href="/app/automations/new"><Button>New automation</Button></Link>}
      />
      {!data ? (
        <div className="text-sm text-stone-500">Loading…</div>
      ) : data.length === 0 ? (
        <Empty title="No automations yet">
          Start with comment-to-DM: someone comments “LINK” on your reel and instantly gets the link in their DMs.
          <div className="mt-4"><Link href="/app/automations/new"><Button>Create your first automation</Button></Link></div>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-stone-100 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr><th className="px-4 py-2.5">Automation</th><th className="hidden px-4 py-2.5 md:table-cell">Trigger</th><th className="px-4 py-2.5 text-right">Runs</th><th className="hidden px-4 py-2.5 text-right sm:table-cell">DMs</th><th className="hidden px-4 py-2.5 text-right sm:table-cell">Clicks</th><th className="px-4 py-2.5">Live</th></tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.map((a) => (
                <tr key={a.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <Link href={`/app/automations/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-stone-500"><Badge tone="amber">{TYPE_LABEL[a.type]}</Badge>@{a.account_username} · edited {timeAgo(a.updated_at)}</div>
                  </td>
                  <td className="hidden max-w-xs truncate px-4 py-3 text-stone-600 md:table-cell">{triggerSummary(a)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{a.runs}</td>
                  <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{a.dms_sent}</td>
                  <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{a.clicks}</td>
                  <td className="px-4 py-3">
                    {canEdit(me) ? (
                      <Toggle checked={a.status === "active"} onChange={async (v) => { await api(`/api/automations/${a.id}/status`, { method: "PATCH", body: { status: v ? "active" : "paused" } }); void reload(); }} />
                    ) : <Badge tone={a.status === "active" ? "green" : "stone"}>{a.status}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
