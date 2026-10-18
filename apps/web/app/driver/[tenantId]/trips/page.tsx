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

interface Trip {
  id: string;
  vehicleId: string;
  purpose: string;
  originDeclared: string;
  destinationDeclared: string;
  startOdometer: number;
  startedAt: string;
}

const whole = (value: string) => /^\d+$/.test(value.trim());

export default function TripsPage() {
  const driver = useDriver();
  const outbox = useOutbox(driver.tenantId);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [openTrip, setOpenTrip] = useState<Trip | null>(null);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [start, setStart] = useState({
    vehicleId: "",
    purpose: "",
    origin: "",
    destination: "",
    odometer: "",
  });
  const [note, setNote] = useState("");
  const [endOdometer, setEndOdometer] = useState("");

  // Reload when queued writes change, so a trip started offline appears once it syncs.
  const outboxKey = outbox.items.map((i) => `${i.id}:${i.status}`).join("|");
  useEffect(() => {
    if (!driver.linkedDriverId) return;
    let cancelled = false;
    (async () => {
      try {
        const [v, t] = await Promise.all([
          apiFetch<{ items: Vehicle[] }>(
            "GET",
            `/tenants/${driver.tenantId}/vehicles?status=active`,
          ),
          apiFetch<{ items: Trip[] }>(
            "GET",
            `/tenants/${driver.tenantId}/trips?driverId=${driver.linkedDriverId}&status=open`,
          ),
        ]);
        if (cancelled) return;
        setVehicles(v.items);
        setOpenTrip(t.items[0] ?? null);
        setStale(false);
      } catch {
        if (!cancelled) setStale(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driver.tenantId, driver.linkedDriverId, outboxKey]);

  if (!driver.linkedDriverId) {
    return (
      <section>
        <h1>Trips</h1>
        <p>Your login is not linked to a driver record, so trips cannot be started here.</p>
      </section>
    );
  }

  async function startTrip(event: FormEvent) {
    event.preventDefault();
    if (
      !start.vehicleId ||
      !start.purpose.trim() ||
      !start.origin.trim() ||
      !start.destination.trim()
    ) {
      setMessage("Fill in the vehicle, purpose, origin and destination.");
      return;
    }
    if (!whole(start.odometer)) {
      setMessage("Enter the odometer reading as a whole number.");
      return;
    }
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: "Start trip",
      path: `/tenants/${driver.tenantId}/trips`,
      body: {
        vehicleId: start.vehicleId,
        driverId: driver.linkedDriverId,
        purpose: start.purpose.trim(),
        originDeclared: start.origin.trim(),
        destinationDeclared: start.destination.trim(),
        startOdometer: Number(start.odometer),
      },
    });
    setStart({ vehicleId: "", purpose: "", origin: "", destination: "", odometer: "" });
    setMessage("Trip saved to your outbox. It will start once you are online.");
  }

  async function stop(eventType: "arrived" | "departed") {
    if (!openTrip) return;
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: `Trip ${eventType}`,
      path: `/tenants/${driver.tenantId}/trips/${openTrip.id}/stops`,
      body: { eventType },
    });
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!openTrip || !note.trim()) return;
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: "Trip note",
      path: `/tenants/${driver.tenantId}/trips/${openTrip.id}/stops`,
      body: { eventType: "note", note: note.trim() },
    });
    setNote("");
  }

  async function complete(event: FormEvent) {
    event.preventDefault();
    if (!openTrip) return;
    if (!whole(endOdometer)) {
      setMessage("Enter the end odometer as a whole number.");
      return;
    }
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: "End trip",
      path: `/tenants/${driver.tenantId}/trips/${openTrip.id}/complete`,
      body: { endOdometer: Number(endOdometer) },
    });
    setEndOdometer("");
    setMessage("Trip end saved to your outbox.");
  }

  return (
    <section>
      <h1>Trips</h1>
      {stale ? <p role="status">Offline: trip status may be out of date.</p> : null}
      {openTrip ? (
        <div>
          <p>
            Open trip: {openTrip.purpose}, {openTrip.originDeclared} to{" "}
            {openTrip.destinationDeclared}, started at odometer {openTrip.startOdometer}.
          </p>
          <p>
            <button type="button" onClick={() => void stop("arrived")}>
              Arrived
            </button>{" "}
            <button type="button" onClick={() => void stop("departed")}>
              Departed
            </button>
          </p>
          <form onSubmit={addNote}>
            <label>
              Stop note{" "}
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </label>{" "}
            <button type="submit">Add note</button>
          </form>
          <form onSubmit={complete}>
            <label>
              End odometer{" "}
              <input
                inputMode="numeric"
                value={endOdometer}
                onChange={(e) => setEndOdometer(e.target.value)}
              />
            </label>{" "}
            <button type="submit">End trip</button>
          </form>
        </div>
      ) : (
        <form onSubmit={startTrip}>
          <h2>Start a trip</h2>
          <label>
            Vehicle{" "}
            <select
              value={start.vehicleId}
              onChange={(e) => setStart({ ...start, vehicleId: e.target.value })}
            >
              <option value="">Choose…</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plateNumber} {v.make} {v.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            Purpose{" "}
            <input
              value={start.purpose}
              onChange={(e) => setStart({ ...start, purpose: e.target.value })}
              maxLength={200}
            />
          </label>
          <label>
            From{" "}
            <input
              value={start.origin}
              onChange={(e) => setStart({ ...start, origin: e.target.value })}
              maxLength={200}
            />
          </label>
          <label>
            To{" "}
            <input
              value={start.destination}
              onChange={(e) => setStart({ ...start, destination: e.target.value })}
              maxLength={200}
            />
          </label>
          <label>
            Odometer{" "}
            <input
              inputMode="numeric"
              value={start.odometer}
              onChange={(e) => setStart({ ...start, odometer: e.target.value })}
            />
          </label>
          <button type="submit">Start trip</button>
        </form>
      )}
      {message ? <p role="status">{message}</p> : null}
      <OutboxPanel items={outbox.items} />
    </section>
  );
}
