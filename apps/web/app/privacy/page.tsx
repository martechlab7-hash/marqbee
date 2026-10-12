import { Legal } from "@/components/legal";
export const metadata = { title: "Privacy Policy" };

// Template — have counsel review before launch (DPDP Act 2023, Meta Platform Terms).
export default function Privacy() {
  return (
    <Legal title="Privacy Policy">
      <p>Marqbee helps creators and businesses manage their Instagram professional accounts. This policy explains what we collect and why, in line with India&apos;s Digital Personal Data Protection Act, 2023 and Meta&apos;s Platform Terms.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account holders: name, email, password hash, workspace and team details.</li>
        <li>Connected Instagram accounts: account id, username, and an access token, encrypted at rest and never logged.</li>
        <li>People who interact with a connected account (comments, DMs, story replies and mentions, link clicks): Instagram-scoped id, username, message content, and any email or phone they choose to share.</li>
        <li>Bio page visitors: page views and link clicks with referrer, approximate country and UTM parameters. No cross-site tracking cookies.</li>
      </ul>
      <h2>How we use it</h2>
      <p>Only to provide the service the account holder configured: sending automated and human replies via Meta&apos;s official API, showing the inbox and contacts, and reporting analytics. We do not sell personal data or use it for advertising.</p>
      <h2>Your rights</h2>
      <p>Account holders can export or delete any contact from the dashboard. Anyone whose data is held by a Marqbee customer can contact that business, or us at privacy@marqbee.app, to access, correct or erase it. Removing Marqbee from your Instagram settings triggers deletion of the connected account&apos;s data.</p>
      <h2>Retention</h2>
      <p>Raw webhook logs are kept for 30 days. Contacts and messages are kept until the account holder deletes them or closes their workspace. Backups roll off within 35 days.</p>
      <h2>Where data is stored</h2>
      <p>In AWS Mumbai (ap-south-1).</p>
    </Legal>
  );
}
