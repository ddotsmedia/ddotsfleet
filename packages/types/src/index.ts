export type Role =
  | "platform_owner" | "company_admin" | "fleet_manager" | "dispatcher" | "maintenance_officer"
  | "finance_officer" | "supervisor" | "driver" | "read_only_management";
export interface HealthStatus { status: "ok" | "degraded"; service: string; timestamp: string }
