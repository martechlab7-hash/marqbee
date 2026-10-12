import Link from "next/link";
export function Legal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm font-bold">🐝 Marqbee</Link>
      <h1 className="mt-6 text-3xl font-bold">{title}</h1>
      <div className="mt-6 space-y-4 text-sm leading-relaxed text-stone-700 [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ink-900 [&_li]:ml-5 [&_li]:list-disc">{children}</div>
    </main>
  );
}
