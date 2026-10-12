"use client";
import { useEffect } from "react";

export function ViewBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const utm = Object.fromEntries([...q.entries()].filter(([k]) => k.startsWith("utm_")));
    const body = JSON.stringify({ referrer: document.referrer || null, utm });
    const url = `/public/bio/${slug}/view`;
    if (!navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) {
      void fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
    }
  }, [slug]);
  return null;
}
