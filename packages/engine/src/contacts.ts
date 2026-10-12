import type { Db, ContactRow, IgAccountRow } from "@marqbee/db";

export async function upsertContact(
  tx: Db,
  account: Pick<IgAccountRow, "id" | "workspace_id">,
  igsid: string,
  opts: { username?: string; inboundAt?: Date; source?: Record<string, unknown> } = {},
): Promise<ContactRow & { inserted: boolean }> {
  const [row] = await tx<(ContactRow & { inserted: boolean })[]>`
    insert into contacts (workspace_id, ig_account_id, igsid, username, source, last_inbound_at)
    values (${account.workspace_id}, ${account.id}, ${igsid}, ${opts.username ?? null},
            ${tx.json((opts.source ?? {}) as never)}, ${opts.inboundAt ?? null})
    on conflict (ig_account_id, igsid) do update set
      username = coalesce(excluded.username, contacts.username),
      last_inbound_at = greatest(contacts.last_inbound_at, excluded.last_inbound_at)
    returning *, (xmax = 0) as inserted`;
  return row!;
}

export async function addTags(tx: Db, contactId: string, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await tx`update contacts set tags = (select array(select distinct unnest(tags || ${tags}::text[]))) where id = ${contactId}`;
}

export async function removeTags(tx: Db, contactId: string, tags: string[]): Promise<void> {
  await tx`update contacts set tags = array(select t from unnest(tags) t where t <> all(${tags}::text[])) where id = ${contactId}`;
}
