import Link from "next/link";

const FEATURES = [
  { t: "Comment-to-DM, free forever", d: "Keyword triggers per reel or across all posts, rotating public replies, buttons, and a follow-first gate. Unlimited on the free plan." },
  { t: "Every comment becomes a contact", d: "Who commented, on which reel, with which keyword — tagged and searchable, with email and phone capture." },
  { t: "One inbox for the team", d: "Assign conversations, pause the bot per person, saved replies, and the 24-hour window shown on every thread." },
  { t: "Link-in-bio that converts", d: "A fast mobile page with themes, YouTube and Spotify embeds, and click analytics per link." },
  { t: "Know which reel sold", d: "Tracked links in every DM tie clicks back to the post and keyword that started the conversation." },
  { t: "Built on Meta's official API", d: "No passwords, no headless browsers. Rate limits respected so your account stays safe on a viral post." },
];

export default function Home() {
  return (
    <main>
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 text-lg font-bold"><span aria-hidden>🐝</span> Marqbee</div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-2 hover:bg-stone-100">Log in</Link>
          <Link href="/signup" className="rounded-lg bg-ink-900 px-3.5 py-2 font-medium text-white hover:bg-ink-700">Start free</Link>
        </div>
      </nav>
      <section className="mx-auto max-w-4xl px-6 pb-16 pt-16 text-center">
        <span className="rounded-full bg-honey-100 px-3 py-1 text-xs font-semibold text-honey-700">For Indian creators & D2C brands</span>
        <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-6xl">Turn every comment into a customer.</h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-stone-600">
          Link-in-bio, comment-to-DM automations, a shared inbox and a contact CRM — so you can see which reel produced which sale. Priced in ₹.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/signup" className="rounded-xl bg-ink-900 px-5 py-3 font-semibold text-white hover:bg-ink-700">Create your free account</Link>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-6 pb-20 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.t} className="rounded-2xl border border-stone-200 bg-white p-6">
            <h3 className="font-semibold">{f.t}</h3>
            <p className="mt-2 text-sm text-stone-600">{f.d}</p>
          </div>
        ))}
      </section>
      <section className="mx-auto max-w-5xl px-6 pb-24">
        <h2 className="text-center text-2xl font-bold">Simple pricing. No per-contact billing.</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Free", "₹0", "Bio page, unlimited comment-to-DM, 1 account"],
            ["Creator Pro", "₹499/mo", "Story triggers, follow gate, lead capture, custom domain, no badge"],
            ["Business", "₹1,999/mo", "Flow builder, inbox with 3 seats, segments, revenue attribution"],
            ["Agency", "₹7,999+/mo", "10+ accounts, client workspaces, white-label reports"],
          ].map(([n, p, d]) => (
            <div key={n} className="rounded-2xl border border-stone-200 bg-white p-5">
              <div className="text-sm font-semibold text-stone-500">{n}</div>
              <div className="mt-1 text-2xl font-bold">{p}</div>
              <p className="mt-2 text-sm text-stone-600">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t border-stone-200 py-8 text-center text-xs text-stone-500">
        <Link href="/privacy" className="hover:underline">Privacy</Link> · <Link href="/terms" className="hover:underline">Terms</Link> · <Link href="/data-deletion" className="hover:underline">Data deletion</Link>
      </footer>
    </main>
  );
}
