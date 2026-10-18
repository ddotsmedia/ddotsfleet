"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useDriver } from "@/components/driver-shell";
import { OutboxPanel } from "@/components/outbox-panel";
import { apiFetch } from "@/lib/api";
import { enqueueWrite } from "@/lib/sync";
import { useOutbox } from "@/lib/use-outbox";

interface Vehicle {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
}

type Answer = "pass" | "fail" | "na";
type Severity = "minor" | "major" | "critical";

/** Fixed checklist for this release. Tenant-editable templates are not built yet. */
const TEMPLATE = [
  { code: "brakes", label: "Brakes" },
  { code: "tyres", label: "Tyres and wheels" },
  { code: "lights", label: "Lights and indicators" },
  { code: "fluids", label: "Fluid levels" },
  { code: "damage", label: "Body damage" },
];

interface Row {
  answer: Answer;
  severity: Severity;
  notes: string;
}

export default function VehicleCheckPage() {
  const driver = useDriver();
  const outbox = useOutbox(driver.tenantId);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [kind, setKind] = useState<"pre_trip" | "post_trip">("pre_trip");
  const [rows, setRows] = useState<Record<string, Row>>(
    Object.fromEntries(
      TEMPLATE.map((t) => [t.code, { answer: "pass", severity: "major", notes: "" }]),
    ),
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ items: Vehicle[] }>("GET", `/tenants/${driver.tenantId}/vehicles?status=active`)
      .then((res) => setVehicles(res.items))
      .catch(() => setMessage("Vehicle list unavailable offline. Try again when connected."));
  }, [driver.tenantId]);

  function update(code: string, patch: Partial<Row>) {
    setRows((prev) => ({ ...prev, [code]: { ...prev[code]!, ...patch } }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!vehicleId) {
      setMessage("Choose a vehicle first.");
      return;
    }
    const items = TEMPLATE.map((t) => {
      const row = rows[t.code]!;
      return row.answer === "fail"
        ? {
            code: t.code,
            label: t.label,
            answer: "fail",
            severity: row.severity,
            notes: row.notes || undefined,
          }
        : { code: t.code, label: t.label, answer: row.answer };
    });
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: `${kind === "pre_trip" ? "Pre-trip" : "Post-trip"} check`,
      path: `/tenants/${driver.tenantId}/inspections`,
      body: { vehicleId, kind, items },
    });
    const anyCritical = items.some((i) => "severity" in i && i.severity === "critical");
    setMessage(
      anyCritical
        ? "Saved to your outbox. A critical defect will block dispatch until it is cleared."
        : "Saved to your outbox. It will be sent when you are online.",
    );
  }

  return (
    <section>
      <h1>Vehicle check</h1>
      <form onSubmit={submit}>
        <label>
          Vehicle{" "}
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">Choose…</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.plateNumber} {v.make} {v.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          Check{" "}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "pre_trip" | "post_trip")}
          >
            <option value="pre_trip">Pre-trip</option>
            <option value="post_trip">Post-trip</option>
          </select>
        </label>
        {TEMPLATE.map((t) => {
          const row = rows[t.code]!;
          return (
            <fieldset key={t.code}>
              <legend>{t.label}</legend>
              <label>
                Answer{" "}
                <select
                  value={row.answer}
                  onChange={(e) => update(t.code, { answer: e.target.value as Answer })}
                >
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                  <option value="na">Not applicable</option>
                </select>
              </label>
              {row.answer === "fail" ? (
                <>
                  <label>
                    Severity{" "}
                    <select
                      value={row.severity}
                      onChange={(e) => update(t.code, { severity: e.target.value as Severity })}
                    >
                      <option value="minor">Minor</option>
                      <option value="major">Major</option>
                      <option value="critical">Critical (blocks dispatch)</option>
                    </select>
                  </label>
                  <label>
                    Notes{" "}
                    <input
                      value={row.notes}
                      onChange={(e) => update(t.code, { notes: e.target.value })}
                      maxLength={1000}
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
          );
        })}
        <button type="submit">Save check</button>
      </form>
      {message ? <p role="status">{message}</p> : null}
      <OutboxPanel items={outbox.items} />
    </section>
  );
}
