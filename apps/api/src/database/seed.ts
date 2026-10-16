import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { createTenantRoles, ensurePermissionCatalog } from "./catalog.js";

// Fixed UUIDs keep the seed idempotent across runs.
const id = (block: string, n: number): string =>
  `00000000-0000-4000-${block}-${n.toString(16).padStart(12, "0")}`;

export const DEMO_TENANT_ID = id("8000", 1);

export async function runSeed(prisma: PrismaClient): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {},
    create: { id: DEMO_TENANT_ID, name: "Demo UAE Fleet", slug: "demo-uae" },
  });
  const permIds = await ensurePermissionCatalog(prisma, (i) => id("9000", i + 1));
  await createTenantRoles(prisma, DEMO_TENANT_ID, permIds, (i) => id("a000", i + 1));
}

// Run directly: `pnpm --filter @fleetos/api db:seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  runSeed(prisma)
    .then(() => console.log("seed: ok"))
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
