"use client";
import { useEffect, useRef, useState } from "react";
import { api, timeAgo, useApi } from "@/lib/api";
import { Badge, Button, Empty, ErrorNote, Input, PageHeader, Textarea, Toggle, cx } from "@/components/ui";
import { useMe } from "@/components/session";

interface Thread {
  id: string;
  username: string | null;
  igsid: string;
  account_username: string;
  last_body: string;
  last_direction: "in" | "out";
  last_message_at: string;
  unread_count: number;
  bot_paused: boolean;
  tags: string[];
  window_open: boolean;
  human_agent_open: boolean;
  window_expires_at: string | null;
}
interface Msg {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  status: string;
  error_code: string | null;
  sent_by: string | null;
  sent_by_name: string | null;
  automation_name: string | null;
  created_at: string;
}

function windowLabel(t: Thread) {
  if (t.window_open && t.window_expires_at) {
    const h = Math.max(0, Math.round((new Date(t.window_expires_at).getTime() - Date.now()) / 3600_000));
    return { text: `Window open · ${h}h left`, tone: "green" as const };
  }
  if (t.human_agent_open) return { text: "Human-agent reply only (7d)", tone: "amber" as const };
  return { text: "Window closed", tone: "stone" as const };
}

export default function InboxPage() {
  const me = useMe();
  const [filter, setFilter] = useState<"all" | "unread" | "mine" | "paused">("all");
  const [q, setQ] = useState("");
  const { data: threads, reload } = useApi<Thread[]>(`/api/inbox?filter=${filter}&q=${encodeURIComponent(q)}`, [filter, q]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = threads?.find((t) => t.id === activeId) ?? null;

  // Light polling keeps the inbox live without websockets in the MVP.
  useEffect(() => {
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <PageHeader title="Inbox" sub="Every DM, story reply and automation conversation, shared with your team." />
      <div className="grid h-[calc(100vh-11rem)] min-h-[480px] overflow-hidden rounded-xl border border-stone-200 bg-white md:grid-cols-[320px_1fr]">
        <div className={cx("flex min-h-0 flex-col border-r border-stone-200", active && "hidden md:flex")}>
          <div className="space-y-2 border-b border-stone-100 p-3">
            <Input placeholder="Search username" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="flex gap-1 text-xs">
              {(["all", "unread", "mine", "paused"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cx("rounded-full px-2.5 py-1 capitalize", filter === f ? "bg-ink-900 text-white" : "text-stone-600 hover:bg-stone-100")}>
                  {f === "paused" ? "Bot paused" : f}
                </button>
              ))}
            </div>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-stone-100 overflow-y-auto">
            {threads?.map((t) => (
              <li key={t.id}>
                <button onClick={() => setActiveId(t.id)} className={cx("block w-full px-3 py-3 text-left hover:bg-stone-50", activeId === t.id && "bg-honey-50")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={cx("truncate text-sm", t.unread_count ? "font-bold" : "font-medium")}>@{t.username ?? t.igsid}</span>
                    <span className="flex-none text-xs text-stone-400">{timeAgo(t.last_message_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="truncate text-xs text-stone-500">{t.last_direction === "out" ? "You: " : ""}{t.last_body || "(attachment)"}</span>
                    {t.unread_count > 0 && <span className="ml-auto flex-none rounded-full bg-honey-500 px-1.5 text-[10px] font-bold text-white">{t.unread_count}</span>}
                  </div>
                </button>
              </li>
            ))}
            {threads && threads.length === 0 && <li className="p-6 text-center text-sm text-stone-500">No conversations yet.</li>}
          </ul>
        </div>
        {active ? (
          <Conversation key={active.id} thread={active} canSend={me.workspace.role !== "viewer"} onBack={() => setActiveId(null)} onChange={reload} />
        ) : (
          <div className="hidden items-center justify-center md:flex"><Empty title="Pick a conversation">Replies sent here go out as you, from your Instagram account.</Empty></div>
        )}
      </div>
    </>
  );
}

function Conversation({ thread, canSend, onBack, onChange }: { thread: Thread; canSend: boolean; onBack: () => void; onChange: () => void }) {
  const { data: msgs, reload } = useApi<Msg[]>(`/api/inbox/${thread.id}/messages`);
  const { data: saved } = useApi<{ id: string; title: string; body: string }[]>("/api/saved-replies");
  const [text, setText] = useState("");
  const [humanAgent, setHumanAgent] = useState(false);
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const w = windowLabel(thread);
  const canReply = thread.window_open || (humanAgent && thread.human_agent_open);

  useEffect(() => end.current?.scrollIntoView(), [msgs?.length]);
  useEffect(() => {
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        <button className="text-sm md:hidden" onClick={onBack}>←</button>
        <div className="mr-auto">
          <div className="font-semibold">@{thread.username ?? thread.igsid}</div>
          <div className="text-xs text-stone-500">via @{thread.account_username} {thread.tags.length > 0 && `· ${thread.tags.join(", ")}`}</div>
        </div>
        <Badge tone={w.tone}>{w.text}</Badge>
        {canSend && (
          <Toggle checked={thread.bot_paused} label="Pause bot" onChange={async (v) => { await api(`/api/contacts/${thread.id}`, { method: "PATCH", body: { botPaused: v } }); onChange(); }} />
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-stone-50 p-4">
        {msgs?.map((m) => (
          <div key={m.id} className={cx("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
            <div className={cx("max-w-[75%] rounded-2xl px-3 py-2 text-sm", m.direction === "out" ? (m.kind === "public_reply" ? "border border-dashed border-stone-300 bg-white text-stone-600" : "bg-ink-900 text-white") : "bg-white shadow-sm")}>
              {m.kind === "story_mention" && <div className="mb-1 text-xs font-semibold opacity-70">Mentioned you in their story</div>}
              {m.kind === "story_reply" && <div className="mb-1 text-xs font-semibold opacity-70">Replied to your story</div>}
              {m.kind === "public_reply" && <div className="mb-1 text-xs font-semibold">Public comment reply</div>}
              {m.kind === "postback" && <div className="mb-1 text-xs font-semibold opacity-70">Tapped a button</div>}
              <p className="whitespace-pre-wrap">{m.body}</p>
              <div className={cx("mt-1 text-[10px]", m.direction === "out" && m.kind !== "public_reply" ? "text-white/60" : "text-stone-400")}>
                {timeAgo(m.created_at)}
                {m.direction === "out" && ` · ${m.sent_by === "bot" ? `🤖 ${m.automation_name ?? "automation"}` : m.sent_by === "human" ? m.sent_by_name ?? "teammate" : "Instagram app"}`}
                {m.status !== "sent" && m.status !== "received" && ` · ${m.status}${m.error_code ? ` (${m.error_code})` : ""}`}
              </div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {canSend && (
        <form
          className="space-y-2 border-t border-stone-200 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setError(undefined);
            try {
              await api(`/api/inbox/${thread.id}/messages`, { body: { text, humanAgent } });
              setText("");
              void reload();
              onChange();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <ErrorNote error={error} />
          {saved && saved.length > 0 && (
            <div className="flex flex-wrap gap-1">{saved.map((s) => <button type="button" key={s.id} onClick={() => setText(s.body)} className="rounded-full border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-50">{s.title}</button>)}</div>
          )}
          <div className="flex gap-2">
            <Textarea rows={2} className="flex-1" placeholder={canReply ? "Write a reply…" : "The 24h window is closed — they need to message you first."} value={text} onChange={(e) => setText(e.target.value)} disabled={!canReply}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <Button disabled={!canReply || !text.trim()}>Send</Button>
          </div>
          {!thread.window_open && thread.human_agent_open && (
            <Toggle checked={humanAgent} onChange={setHumanAgent} label="Send with human-agent tag (genuine human replies only, up to 7 days)" />
          )}
        </form>
      )}
    </div>
  );
}
