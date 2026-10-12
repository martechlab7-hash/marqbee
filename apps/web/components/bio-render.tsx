/* Shared by the public bio page (server) and the editor's live preview (client). */

export type BioBlock =
  | { id?: string; type: "link"; enabled?: boolean; data: { title: string; url: string; thumbnail?: string; highlight?: boolean; utm?: Record<string, string> } }
  | { id?: string; type: "header"; enabled?: boolean; data: { text: string } }
  | { id?: string; type: "text"; enabled?: boolean; data: { text: string } }
  | { id?: string; type: "youtube"; enabled?: boolean; data: { url: string } }
  | { id?: string; type: "spotify"; enabled?: boolean; data: { url: string } }
  | { id?: string; type: "socials"; enabled?: boolean; data: { links: { network: string; url: string }[] } };

export interface BioPageData {
  slug: string;
  title: string;
  bio: string;
  avatar_url?: string | null;
  theme: { preset: string; buttonStyle?: "rounded" | "pill" | "square" };
  show_badge: boolean;
  blocks: BioBlock[];
}

export const THEMES: Record<string, { bg: string; text: string; sub: string; btn: string; btnText: string; hl: string }> = {
  sunrise: { bg: "linear-gradient(160deg,#fff7e6 0%,#ffe1c2 45%,#ffc9b5 100%)", text: "#2a1a0f", sub: "#6b4a35", btn: "#ffffff", btnText: "#2a1a0f", hl: "#f59e0b" },
  midnight: { bg: "linear-gradient(170deg,#0f1222 0%,#1c1f3a 100%)", text: "#f5f5ff", sub: "#a9acc9", btn: "rgba(255,255,255,0.08)", btnText: "#f5f5ff", hl: "#8b7dff" },
  mint: { bg: "linear-gradient(160deg,#ecfdf5 0%,#ccfbf1 100%)", text: "#053b33", sub: "#2f6f65", btn: "#ffffff", btnText: "#053b33", hl: "#10b981" },
  paper: { bg: "#faf9f7", text: "#16130f", sub: "#6b645a", btn: "#ffffff", btnText: "#16130f", hl: "#16130f" },
  candy: { bg: "linear-gradient(160deg,#fdf2f8 0%,#ede9fe 100%)", text: "#3b0a2a", sub: "#7a3b63", btn: "#ffffff", btnText: "#3b0a2a", hl: "#ec4899" },
};

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return m ? m[1]! : null;
}

function spotifyEmbed(url: string): string | null {
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show|artist)\/(\w+)/);
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
}

const SOCIAL_LABEL: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", x: "X", linkedin: "LinkedIn", whatsapp: "WhatsApp", email: "Email", website: "Website", threads: "Threads" };

export function BioPageView({ page, preview = false }: { page: BioPageData; preview?: boolean }) {
  const t = THEMES[page.theme.preset] ?? THEMES.sunrise!;
  const radius = page.theme.buttonStyle === "square" ? "8px" : page.theme.buttonStyle === "rounded" ? "16px" : "999px";
  const href = (b: Extract<BioBlock, { type: "link" }>) => (preview || !b.id ? b.data.url : `/b/${b.id}`);
  return (
    <div style={{ background: t.bg, color: t.text, minHeight: "100%" }} className="flex w-full justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          {page.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={page.avatar_url} alt="" className="h-24 w-24 rounded-full object-cover shadow-md ring-4 ring-white/60" />
          ) : (
            <div className="flex h-24 w-24 items-center justify-center rounded-full text-3xl font-semibold shadow-md ring-4 ring-white/60" style={{ background: t.hl, color: "#fff" }}>
              {(page.title || page.slug).slice(0, 1).toUpperCase()}
            </div>
          )}
          <h1 className="mt-4 text-xl font-bold">{page.title || `@${page.slug}`}</h1>
          {page.bio && <p className="mt-1.5 max-w-sm whitespace-pre-line text-sm" style={{ color: t.sub }}>{page.bio}</p>}
        </div>

        <div className="mt-7 space-y-3">
          {page.blocks.filter((b) => b.enabled !== false).map((b, i) => {
            const key = b.id ?? i;
            switch (b.type) {
              case "header":
                return <h2 key={key} className="pt-3 text-center text-xs font-semibold uppercase tracking-widest" style={{ color: t.sub }}>{b.data.text}</h2>;
              case "text":
                return <p key={key} className="whitespace-pre-line text-center text-sm" style={{ color: t.sub }}>{b.data.text}</p>;
              case "link":
                return (
                  <a
                    key={key}
                    href={href(b)}
                    target={preview ? "_blank" : undefined}
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-4 py-3.5 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                    style={{ background: b.data.highlight ? t.hl : t.btn, color: b.data.highlight ? "#fff" : t.btnText, borderRadius: radius, border: "1px solid rgba(0,0,0,0.06)" }}
                  >
                    {b.data.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.data.thumbnail} alt="" className="h-9 w-9 rounded-md object-cover" />
                    )}
                    <span className="flex-1 text-center">{b.data.title}</span>
                    {b.data.thumbnail && <span className="w-9" />}
                  </a>
                );
              case "youtube": {
                const id = youtubeId(b.data.url);
                return id ? (
                  <div key={key} className="aspect-video overflow-hidden rounded-2xl shadow-sm">
                    <iframe className="h-full w-full" src={`https://www.youtube-nocookie.com/embed/${id}`} title="YouTube video" allow="encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
                  </div>
                ) : null;
              }
              case "spotify": {
                const src = spotifyEmbed(b.data.url);
                return src ? <iframe key={key} className="w-full rounded-2xl" src={src} height="152" title="Spotify" allow="encrypted-media" loading="lazy" /> : null;
              }
              case "socials":
                return (
                  <div key={key} className="flex flex-wrap justify-center gap-2 pt-1">
                    {b.data.links.map((l, j) => (
                      <a key={j} href={l.network === "email" && !l.url.startsWith("mailto:") ? `mailto:${l.url}` : l.url} target="_blank" rel="noopener noreferrer"
                         className="rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: t.btn, color: t.btnText, border: "1px solid rgba(0,0,0,0.06)" }}>
                        {SOCIAL_LABEL[l.network] ?? l.network}
                      </a>
                    ))}
                  </div>
                );
            }
          })}
        </div>

        {page.show_badge && (
          <div className="mt-10 text-center">
            <a href="/" className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-stone-700 shadow-sm backdrop-blur">
              <span aria-hidden>🐝</span> Made with Marqbee
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
