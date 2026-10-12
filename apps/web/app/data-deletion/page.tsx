import { Legal } from "@/components/legal";
import { backendJson } from "@/lib/backend";
export const metadata = { title: "Data deletion" };

export const dynamic = "force-dynamic";

export default async function DataDeletion({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  let status: string | null = null;
  if (code && /^[a-f0-9]{20}$/.test(code)) {
    const r = await backendJson<{ status: string }>(`/meta/data-deletion/${code}`).catch(() => null);
    status = r?.status ?? "not_found";
  }
  return (
    <Legal title="Data deletion">
      {code && (
        <p className="rounded-lg border border-stone-200 bg-white p-4">
          Request <code>{code}</code>: <strong>{status === "completed" ? "completed — your data has been deleted" : status === "pending" ? "in progress" : "not found"}</strong>
        </p>
      )}
      <p>To delete the data Marqbee holds for your Instagram account, remove Marqbee under Instagram → Settings → Website permissions → Apps and websites. We delete the connected account, its contacts, messages and automations automatically and give you a confirmation code to check here.</p>
      <p>You can also email privacy@marqbee.app from the address on your account.</p>
    </Legal>
  );
}
