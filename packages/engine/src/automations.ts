import { compileAutomation, validateGraph, type AutomationConfig, type FlowGraph, type TriggerConfig, type TriggerKind } from "@marqbee/core";
import type { Db } from "@marqbee/db";

export interface AutomationInput {
  igAccountId: string;
  name: string;
  type: TriggerKind;
  trigger: TriggerConfig;
  config: AutomationConfig;
  status?: "active" | "paused";
}

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
  }
}

export function validateAutomation(input: AutomationInput): string[] {
  const issues: string[] = [];
  if (!input.name.trim()) issues.push("name is required");
  if (!input.config.message?.text?.trim()) issues.push("DM message text is required");
  if ((input.config.message?.buttons?.length ?? 0) > 3) issues.push("at most 3 buttons");
  for (const b of input.config.message?.buttons ?? []) {
    if (b.type === "url" && !/^https?:\/\//.test(b.url)) issues.push(`button "${b.title}" needs an http(s) URL`);
  }
  if (input.trigger.mode !== "any" && !input.trigger.keywords.some((k) => k.trim())) issues.push("add at least one keyword, or trigger on any comment");
  if (input.config.followGate?.enabled && !input.config.followGate.gateText.trim()) issues.push("follow gate message is required");
  return issues;
}

/** Publishes a new immutable flow version and points the flow at it. */
async function publishVersion(tx: Db, workspaceId: string, flowId: string, graph: FlowGraph): Promise<string> {
  const [v] = await tx<{ id: string }[]>`
    insert into flow_versions (workspace_id, flow_id, version, graph)
    values (${workspaceId}, ${flowId},
      (select coalesce(max(version), 0) + 1 from flow_versions where flow_id = ${flowId}),
      ${tx.json(graph as never)})
    returning id`;
  await tx`update flows set current_version_id = ${v!.id} where id = ${flowId}`;
  return v!.id;
}

export async function createAutomation(tx: Db, workspaceId: string, input: AutomationInput): Promise<{ id: string }> {
  const issues = validateAutomation(input);
  const graph = compileAutomation(input.type, input.config);
  issues.push(...validateGraph(graph));
  if (issues.length) throw new ValidationError(issues);

  const [flow] = await tx<{ id: string }[]>`insert into flows (workspace_id, name) values (${workspaceId}, ${input.name}) returning id`;
  await publishVersion(tx, workspaceId, flow!.id, graph);
  const [a] = await tx<{ id: string }[]>`
    insert into automations (workspace_id, ig_account_id, name, type, trigger, config, flow_id, status)
    values (${workspaceId}, ${input.igAccountId}, ${input.name}, ${input.type}, ${tx.json(input.trigger as never)},
            ${tx.json(input.config as never)}, ${flow!.id}, ${input.status ?? "active"})
    returning id`;
  return a!;
}

/** In-flight runs keep the version they started on; new runs use the new one. */
export async function updateAutomation(tx: Db, workspaceId: string, id: string, input: AutomationInput): Promise<void> {
  const issues = validateAutomation(input);
  const graph = compileAutomation(input.type, input.config);
  issues.push(...validateGraph(graph));
  if (issues.length) throw new ValidationError(issues);
  const [a] = await tx<{ flow_id: string }[]>`select flow_id from automations where id = ${id} and workspace_id = ${workspaceId}`;
  if (!a) throw new ValidationError(["automation not found"]);
  await publishVersion(tx, workspaceId, a.flow_id, graph);
  await tx`
    update automations set name = ${input.name}, type = ${input.type}, trigger = ${tx.json(input.trigger as never)},
      config = ${tx.json(input.config as never)}, status = ${input.status ?? "active"}, updated_at = now()
    where id = ${id}`;
  await tx`update flows set name = ${input.name} where id = ${a.flow_id}`;
}
