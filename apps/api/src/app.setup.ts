import type { NestExpressApplication } from "@nestjs/platform-express";

/** Shared by the server and the e2e tests so both run the same HTTP pipeline. */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix("api/v1", { exclude: ["health/live", "health/ready"] });
  // The default 100kb JSON limit is too small for a 10,000-row CSV import.
  app.useBodyParser("json", { limit: "10mb" });
}
