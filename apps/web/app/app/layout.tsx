"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";
import { cx } from "@/components/ui";
import { SessionCtx, type Me } from "@/components/session";

const NAV = [
  { href: "/app", label: "Overview", icon: "◎" },
  { href: "/app/automations", label: "Automations", icon: "⚡" },
  { href: "/app/inbox", label: "Inbox", icon: "✉" },
  { href: "/app/contacts", label: "Contacts", icon: "◉" },
  { href: "/app/bio", label: "Bio page", icon: "🔗" },
  { href: "/app/accounts", label: "Instagram accounts", icon: "◈" },
  { href: "/app/team", label: "Team", icon: "☺" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: me } = useApi<Me>("/auth/me");
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!me) return <div className="flex min-h-screen items-center justify-center text-sm text-stone-500">Loading…</div>;

  const nav = (
    <nav className="space-y-0.5">
      {NAV.map((n) => {
        const active = n.href === "/app" ? path === "/app" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
            className={cx("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm", active ? "bg-white font-semibold shadow-sm ring-1 ring-stone-200" : "text-stone-600 hover:bg-white/60")}>
            <span className="w-4 text-center text-xs opacity-70" aria-hidden>{n.icon}</span>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <SessionCtx.Provider value={me}>
      <div className="flex min-h-screen">
        <aside className={cx("fixed inset-y-0 left-0 z-30 w-60 flex-col border-r border-stone-200 bg-stone-50 p-4 md:static md:flex", open ? "flex" : "hidden")}>
          <Link href="/app" className="mb-6 flex items-center gap-2 px-2 text-lg font-bold"><span aria-hidden>🐝</span> Marqbee</Link>
          {me.workspaces.length > 1 ? (
            <select className="mb-4 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm" value={me.workspace.id}
              onChange={async (e) => { await api("/auth/switch-workspace", { body: { workspaceId: e.target.value } }); window.location.reload(); }}>
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : (
            <div className="mb-4 px-2 text-xs font-medium uppercase tracking-wide text-stone-500">{me.workspace.name}</div>
          )}
          {nav}
          <div className="mt-auto space-y-2 px-2 pt-6 text-xs text-stone-500">
            {me.metaMode === "fake" && <div className="rounded-md bg-honey-100 px-2 py-1.5 font-medium text-honey-700">Dev mode: sends are simulated</div>}
            <div className="truncate">{me.user.email}</div>
            <div className="flex items-center justify-between">
              <span className="rounded bg-stone-200 px-1.5 py-0.5 font-medium capitalize">{me.workspace.plan.replace("_", " ")} plan</span>
              <button className="hover:text-ink-900" onClick={async () => { await api("/auth/logout", { body: {} }); router.push("/login"); }}>Log out</button>
            </div>
          </div>
        </aside>
        {open && <div className="fixed inset-0 z-20 bg-black/20 md:hidden" onClick={() => setOpen(false)} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-3 md:hidden">
            <button aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-md border border-stone-300 px-2 py-1 text-sm">☰</button>
            <span className="font-bold">🐝 Marqbee</span>
          </div>
          <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </SessionCtx.Provider>
  );
}
