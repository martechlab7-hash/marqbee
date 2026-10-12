import { Legal } from "@/components/legal";
export const metadata = { title: "Terms of Service" };

export default function Terms() {
  return (
    <Legal title="Terms of Service">
      <p>By using Marqbee you agree to these terms and to Instagram&apos;s Terms of Use and Meta&apos;s Platform Terms.</p>
      <h2>Acceptable use</h2>
      <ul>
        <li>No unsolicited or cold messages — automations only reply to people who interacted with you first, as Instagram&apos;s rules require.</li>
        <li>No spam, misleading content, or content that violates Instagram&apos;s Community Guidelines.</li>
        <li>You are responsible for the consent notices on your lead forms and for how you use contacts you collect.</li>
      </ul>
      <h2>Service</h2>
      <p>Instagram limits how many messages can be sent per hour. On viral posts, replies are queued and delivered as fast as those limits allow. We may pause automations that put your account at risk.</p>
      <h2>Billing</h2>
      <p>Paid plans renew monthly in INR with GST invoices. You can cancel any time; access continues until the end of the paid period.</p>
    </Legal>
  );
}
