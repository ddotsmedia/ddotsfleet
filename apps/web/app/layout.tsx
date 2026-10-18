import type { ReactNode } from "react";
import { RegisterServiceWorker } from "@/components/register-sw";

export const metadata = {
  title: "FleetOS",
  description: "UAE commercial fleet management",
  manifest: "/manifest.webmanifest",
};

export const viewport = { themeColor: "#0b5cad", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16, maxWidth: 640 }}>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
