"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, ErrorNote, Field, Input } from "@/components/ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError(undefined);
          try {
            await api(`/auth/${mode}`, { body: Object.fromEntries(f.entries()) });
            router.push("/app");
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Link href="/" className="flex items-center gap-2 text-lg font-bold"><span aria-hidden>🐝</span> Marqbee</Link>
        <h1 className="text-xl font-semibold">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        {mode === "signup" && (
          <>
            <Field label="Your name"><Input name="name" required autoComplete="name" /></Field>
            <Field label="Brand or creator name" hint="Used for your workspace and bio page URL."><Input name="workspaceName" required /></Field>
          </>
        )}
        <Field label="Email"><Input name="email" type="email" required autoComplete="email" /></Field>
        <Field label="Password" hint={mode === "signup" ? "At least 10 characters." : undefined}>
          <Input name="password" type="password" required minLength={mode === "signup" ? 10 : 1} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        </Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}</Button>
        <p className="text-center text-sm text-stone-500">
          {mode === "login" ? <>New here? <Link className="font-medium text-ink-900 underline" href="/signup">Create an account</Link></> : <>Have an account? <Link className="font-medium text-ink-900 underline" href="/login">Log in</Link></>}
        </p>
        {mode === "signup" && <p className="text-center text-xs text-stone-400">By signing up you agree to our <Link href="/terms" className="underline">Terms</Link> and <Link href="/privacy" className="underline">Privacy Policy</Link>.</p>}
      </form>
    </main>
  );
}
