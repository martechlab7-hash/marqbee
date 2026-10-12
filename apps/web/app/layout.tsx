import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Marqbee — Instagram growth & conversion OS", template: "%s · Marqbee" },
  description: "Link-in-bio, comment-to-DM, a shared inbox and a contact CRM for Indian creators and D2C brands — on Meta's official API.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f59e0b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
