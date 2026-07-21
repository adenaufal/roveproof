import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roveproof Checkout Target",
  description: "Target checkout Indonesia yang seluruh datanya sintetis.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
