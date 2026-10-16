import type { ReactNode } from "react";

export const metadata = { title: "FleetOS", description: "UAE commercial fleet management" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16 }}>{children}</body>
    </html>
  );
}
