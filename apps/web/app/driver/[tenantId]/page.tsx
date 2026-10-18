"use client";

import { OutboxPanel } from "@/components/outbox-panel";
import { useDriver } from "@/components/driver-shell";
import { useOutbox } from "@/lib/use-outbox";

export default function MyDayPage() {
  const driver = useDriver();
  const outbox = useOutbox(driver.tenantId);

  return (
    <section>
      <h1>My day</h1>
      <p>
        {driver.linkedDriverId
          ? "Your login is linked to your driver record."
          : "Your login is not linked to a driver record. Ask your fleet manager to link it."}
      </p>
      <OutboxPanel items={outbox.items} />
    </section>
  );
}
