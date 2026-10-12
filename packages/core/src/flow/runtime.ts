import type { OutboundMessage } from "../meta/client.js";
import { pickVariant, renderTemplate } from "../matching.js";
import type { FlowGraph, FlowNode } from "./types.js";

/**
 * Pure-ish flow interpreter. It walks the graph until it reaches something
 * that has to wait (a delay or a user reply) or the end, and hands every side
 * effect to the port. The port never calls Meta directly — it enqueues sends
 * for the send worker.
 */
export interface FlowPort {
  enqueueSend(send: { nodeId: string; message: OutboundMessage }): Promise<void>;
  enqueuePublicReply(send: { nodeId: string; text: string }): Promise<void>;
  addTag(tag: string): Promise<void>;
  removeTag(tag: string): Promise<void>;
  isFollower(): Promise<boolean>;
  hasTag(tag: string): Promise<boolean>;
}

export interface RunContext {
  runId: string;
  vars: Record<string, string | undefined>;
}

export type RunOutcome =
  | { status: "completed" }
  | { status: "waiting"; node: string; resumeAt: Date }
  | { status: "awaiting_input"; node: string }
  | { status: "failed"; error: string };

const MAX_STEPS = 50;

export async function runFlow(graph: FlowGraph, fromNode: string | undefined, ctx: RunContext, port: FlowPort): Promise<RunOutcome> {
  let id = fromNode;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    if (!id) return { status: "completed" };
    const node: FlowNode | undefined = graph.nodes[id];
    if (!node) return { status: "failed", error: `missing node ${id}` };

    switch (node.type) {
      case "end":
        return { status: "completed" };
      case "send_message":
        await port.enqueueSend({ nodeId: node.id, message: renderMessage(node.message, ctx.vars) });
        id = node.next;
        break;
      case "public_reply": {
        const text = pickVariant(node.variants, ctx.runId);
        if (text) await port.enqueuePublicReply({ nodeId: node.id, text: renderTemplate(text, ctx.vars) });
        id = node.next;
        break;
      }
      case "add_tag":
        await port.addTag(node.tag);
        id = node.next;
        break;
      case "remove_tag":
        await port.removeTag(node.tag);
        id = node.next;
        break;
      case "condition": {
        const ok = node.condition.kind === "is_follower" ? await port.isFollower() : await port.hasTag(node.condition.tag);
        id = ok ? node.yes : node.no;
        break;
      }
      case "wait":
        return { status: "waiting", node: node.next ?? "", resumeAt: new Date(Date.now() + node.durationMs) };
      case "wait_for_reply":
        return { status: "awaiting_input", node: node.id };
    }
  }
  return { status: "failed", error: "step limit exceeded (loop?)" };
}

/** Given a run parked on a wait_for_reply node, pick the branch for this input. */
export function routeReply(graph: FlowGraph, nodeId: string, input: { payload?: string; text?: string }): string | null {
  const node = graph.nodes[nodeId];
  if (!node || node.type !== "wait_for_reply") return null;
  if (input.payload) {
    const r = node.routes.find((x) => x.payload === input.payload);
    if (r) return r.next;
  }
  if (input.text !== undefined && node.anyTextNext) return node.anyTextNext;
  return null;
}

function renderMessage(m: OutboundMessage, vars: Record<string, string | undefined>): OutboundMessage {
  return {
    ...m,
    text: renderTemplate(m.text, vars),
    buttons: m.buttons?.map((b) => (b.type === "url" ? { ...b, url: renderTemplate(b.url, vars) } : b)),
  };
}
