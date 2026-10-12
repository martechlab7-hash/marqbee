import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BioPageView, type BioPageData } from "@/components/bio-render";
import { backendJson } from "@/lib/backend";
import { ViewBeacon } from "./view-beacon";

// Cached per slug at the edge/CDN; the API sends s-maxage too.
export const revalidate = 60;

async function load(slug: string): Promise<BioPageData | null> {
  if (!/^[a-z0-9][a-z0-9_.-]{1,39}$/i.test(slug)) return null;
  return backendJson<BioPageData>(`/public/bio/${encodeURIComponent(slug.toLowerCase())}`);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = await load((await params).slug);
  if (!page) return {};
  return { title: { absolute: page.title || `@${page.slug}` }, description: page.bio || undefined, openGraph: { title: page.title, description: page.bio } };
}

export default async function BioPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await load(slug);
  if (!page) notFound();
  return (
    <div className="min-h-screen">
      <BioPageView page={page} />
      <ViewBeacon slug={page.slug} />
    </div>
  );
}
