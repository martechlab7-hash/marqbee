import { afterEach, beforeEach, expect, it } from "vitest";
import { addAutomation, deliver, drain, makeHarness, resetDb, seedAccount, type Harness } from "./helpers.js";

/**
 * Beta gate: a viral post. N unique commenters, every webhook delivered
 * twice (Meta retries) in batched payloads, interleaved with junk comments.
 * Must end with exactly N private replies — zero lost, zero duplicate.
 * Run the full-size test with LOAD_COMMENTS=50000.
 */
const N = Number(process.env.LOAD_COMMENTS ?? 1500);

let h: Harness;
beforeEach(resetDb);
afterEach(async () => h?.close());

it(`viral post: ${N} comments, redelivered, zero lost and zero duplicate DMs`, async () => {
  h = await makeHarness();
  const acc = await seedAccount(h.engine);
  await addAutomation(h.engine, acc, "comment", { keywords: ["link"] }, { message: { text: "here you go" } });

  const batch = 50;
  const bodies = [];
  for (let i = 0; i < N; i += batch) {
    const changes = [];
    for (let j = i; j < Math.min(N, i + batch); j++) {
      changes.push({ field: "comments", value: { id: `c${j}`, text: j % 3 ? "LINK pls" : "link 🔥", from: { id: `u${j}` }, media: { id: "viral" } } });
      changes.push({ field: "comments", value: { id: `junk${j}`, text: "so cute", from: { id: `x${j}` }, media: { id: "viral" } } });
    }
    bodies.push({ object: "instagram", entry: [{ id: acc.ig_user_id, time: Math.floor(Date.now() / 1000), changes }] });
  }
  const t0 = Date.now();
  // Deliver everything twice, the second pass concurrently with processing.
  for (const b of bodies) await deliver(h.engine, b);
  await Promise.all(bodies.map((b) => deliver(h.engine, b)));
  await drain(h.engine, 600_000);
  const secs = (Date.now() - t0) / 1000;

  const ids = h.meta.calls.filter((c) => c.method === "sendPrivateReply").map((c) => c.args[1] as string);
  expect(ids.length).toBe(N);
  expect(new Set(ids).size).toBe(N);
  const [dl] = await h.engine.db`select count(*)::int n from dead_letters`;
  expect(dl!.n).toBe(0);
  console.log(`load: ${N} comments (+${N} junk, all redelivered) in ${secs.toFixed(1)}s → ${(N / secs).toFixed(0)} DMs/s`);
}, 900_000);
