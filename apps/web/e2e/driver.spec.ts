import { expect, test, type Page, type Route } from "@playwright/test";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DRIVER = "22222222-2222-4222-8222-222222222222";
const VEHICLE = "33333333-3333-4333-8333-333333333333";

interface MockOptions {
  signedIn?: boolean;
  /** Responses for successive POST /inspections calls. The last one repeats. */
  inspectionResponses?: Array<{ status: number; body: unknown }>;
}

interface MockApi {
  /** Network is down: requests fail before reaching the server. */
  setOffline(value: boolean): void;
  /** Bodies of inspection writes that reached the server. */
  inspections: Array<{ clientRef: string; items: unknown[] }>;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApi(page: Page, options: MockOptions = {}): Promise<MockApi> {
  let offline = false;
  const responses = [...(options.inspectionResponses ?? [{ status: 201, body: { id: "ok" } }])];
  const inspections: MockApi["inspections"] = [];

  await page.route("**/fleetos-api/**", async (route) => {
    if (offline) return route.abort("internetdisconnected");
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/fleetos-api", "");

    if (request.method() === "GET" && path === `/tenants/${TENANT}/access`) {
      if (options.signedIn === false) return json(route, 401, { message: "unauthorized" });
      return json(route, 200, {
        tenantId: TENANT,
        roleCodes: ["driver"],
        permissions: ["vehicle:read", "job:read", "trip:write", "inspection:write"],
        linkedDriverId: DRIVER,
      });
    }
    if (request.method() === "GET" && path === `/tenants/${TENANT}/vehicles`) {
      return json(route, 200, {
        items: [{ id: VEHICLE, plateNumber: "DXB A 1234", make: "Toyota", model: "Camry" }],
      });
    }
    if (request.method() === "GET" && path === `/tenants/${TENANT}/trips`)
      return json(route, 200, { items: [] });
    if (request.method() === "GET" && path === `/tenants/${TENANT}/dispatch/jobs`) {
      return json(route, 200, { items: [] });
    }
    if (request.method() === "POST" && path === `/tenants/${TENANT}/inspections`) {
      const body = request.postDataJSON() as { clientRef: string; items: unknown[] };
      inspections.push({ clientRef: body.clientRef, items: body.items });
      const next = responses.length > 1 ? responses.shift()! : responses[0]!;
      return json(route, next.status, next.body);
    }
    return json(route, 404, { message: "not_mocked" });
  });

  return {
    setOffline(value: boolean) {
      offline = value;
    },
    inspections,
  };
}

async function fillCheck(page: Page) {
  await page.getByLabel(/Vehicle/).selectOption(VEHICLE);
  await page.getByRole("button", { name: "Save check" }).click();
}

test("queues a vehicle check while offline, keeps it across a reload, and sends it once", async ({
  page,
}) => {
  const api = await mockApi(page);
  await page.goto(`/driver/${TENANT}/check`);
  await expect(page.getByLabel(/Vehicle/)).toBeVisible();

  api.setOffline(true);
  await fillCheck(page);
  const item = page.getByTestId("outbox-item");
  await expect(item).toHaveAttribute("data-status", "pending");

  await page.reload();
  await expect(page.getByTestId("outbox-item")).toHaveAttribute("data-status", "pending");
  expect(api.inspections).toHaveLength(0);

  api.setOffline(false);
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("No items waiting.")).toBeVisible();
  expect(api.inspections).toHaveLength(1);
  expect(api.inspections[0]!.clientRef).toMatch(/^[0-9a-f-]{36}$/);
  expect(api.inspections[0]!.items).toHaveLength(5);
});

test("shows a rejected write with its reason, and a retry reuses the same idempotency key", async ({
  page,
}) => {
  const api = await mockApi(page, {
    inspectionResponses: [
      { status: 409, body: { message: "vehicle_not_available" } },
      { status: 201, body: { id: "ok" } },
    ],
  });
  await page.goto(`/driver/${TENANT}/check`);
  await expect(page.getByLabel(/Vehicle/)).toBeVisible();

  await fillCheck(page);
  const item = page.getByTestId("outbox-item");
  await expect(item).toHaveAttribute("data-status", "failed");
  await expect(item).toContainText("Reason: vehicle_not_available");

  await item.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No items waiting.")).toBeVisible();
  expect(api.inspections).toHaveLength(2);
  expect(api.inspections[1]!.clientRef).toBe(api.inspections[0]!.clientRef);
});

test("sends a signed-out driver to sign-in", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto(`/driver/${TENANT}`);
  await expect(page).toHaveURL(/\/login$/);
});
