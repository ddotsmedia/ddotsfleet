import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "../../database/schema.prisma",
  migrations: {
    path: "../../database/migrations",
    seed: "tsx src/database/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://fleetos:fleetos@localhost:5432/fleetos",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
