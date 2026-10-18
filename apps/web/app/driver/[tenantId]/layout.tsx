import type { ReactNode } from "react";
import { DriverShell } from "@/components/driver-shell";

export default async function DriverLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  return <DriverShell tenantId={tenantId}>{children}</DriverShell>;
}
