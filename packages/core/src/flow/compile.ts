import type { AutomationConfig, FlowGraph, FlowNode, TriggerKind } from "./types.js";
import { MAX_WAIT_MS } from "./types.js";

export const FOLLOW_CHECK_PAYLOAD = "MQB_FOLLOW_CHECK";

/** Compile a simple MVP automation into a flow graph. */
export function compileAutomation(kind: TriggerKind, cfg: AutomationConfig): FlowGraph {
  const nodes: FlowNode[] = [];
  const chain: string[] = [];
  const add = (n: FlowNode) => {
    nodes.push(n);
    chain.push(n.id);
  };

  (cfg.tags ?? []).forEach((tag, i) => add({ id: `tag_${i}`, type: "add_tag", tag }));
  if (kind === "comment" && cfg.publicReplies?.some((v) => v.trim())) {
    add({ id: "public_reply", type: "public_reply", variants: cfg.publicReplies });
  }

  if (cfg.followGate?.enabled) {
    const gateButton = { type: "postback" as const, title: cfg.followGate.buttonTitle || "I followed ✅", payload: FOLLOW_CHECK_PAYLOAD };
    add({ id: "gate", type: "send_message", message: { text: cfg.followGate.gateText, buttons: [gateButton] } });
    add({ id: "await_follow", type: "wait_for_reply", routes: [{ payload: FOLLOW_CHECK_PAYLOAD, next: "check_follow" }] });
    nodes.push(
      { id: "check_follow", type: "condition", condition: { kind: "is_follower" }, yes: "deliver", no: "not_following" },
      { id: "not_following", type: "send_message", message: { text: cfg.followGate.notFollowingText, buttons: [gateButton] }, next: "await_follow" },
      { id: "deliver", type: "send_message", message: cfg.message, next: "end" },
      { id: "end", type: "end" },
    );
  } else {
    add({ id: "deliver", type: "send_message", message: cfg.message });
    add({ id: "end", type: "end" });
  }

  // Link the linear chain.
  for (let i = 0; i < chain.length - 1; i++) {
    const n = nodes.find((x) => x.id === chain[i])!;
    if ("next" in n || n.type === "add_tag" || n.type === "public_reply" || n.type === "send_message") {
      (n as { next?: string }).next ??= chain[i + 1];
    }
  }
  return { start: chain[0]!, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) };
}

export function validateGraph(g: FlowGraph): string[] {
  const errors: string[] = [];
  if (!g.nodes[g.start]) errors.push(`start node "${g.start}" missing`);
  for (const n of Object.values(g.nodes)) {
    const refs: (string | undefined)[] = [];
    if ("next" in n) refs.push(n.next);
    if (n.type === "condition") refs.push(n.yes, n.no);
    if (n.type === "wait_for_reply") refs.push(...n.routes.map((r) => r.next), n.anyTextNext);
    if (n.type === "wait" && n.durationMs > MAX_WAIT_MS) errors.push(`${n.id}: waits must finish inside the 24h window`);
    if (n.type === "send_message" && !n.message.text.trim()) errors.push(`${n.id}: message text is empty`);
    for (const r of refs) if (r && !g.nodes[r]) errors.push(`${n.id}: points to missing node "${r}"`);
  }
  return errors;
}
