import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "SnowBeltTech Lead Portal",
  description: "Multi-tenant lead portal for local service businesses.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", color: "#1f2933", background: "#f8fafc" }}>
        {children}
      </body>
    </html>
  );
}
