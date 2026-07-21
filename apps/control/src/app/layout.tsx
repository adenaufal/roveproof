import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proof Ledger · Roveproof",
  description: "A local-first journey proof ledger for constrained checkout verification.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
