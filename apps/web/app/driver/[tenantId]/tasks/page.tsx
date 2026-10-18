"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useDriver } from "@/components/driver-shell";
import { OutboxPanel } from "@/components/outbox-panel";
import { apiFetch } from "@/lib/api";
import { enqueueWrite } from "@/lib/sync";
import { useOutbox } from "@/lib/use-outbox";

interface Job {
  id: string;
  reference: string;
  customerName: string;
  priority: string;
  status: "planned" | "assigned" | "in_progress" | "completed" | "cancelled";
  driverId: string | null;
}

export default function TasksPage() {
  const driver = useDriver();
  const outbox = useOutbox(driver.tenantId);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [stale, setStale] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const outboxKey = outbox.items.map((i) => `${i.id}:${i.status}`).join("|");
  useEffect(() => {
    if (!driver.linkedDriverId) return;
    let cancelled = false;
    apiFetch<{ items: Job[] }>("GET", `/tenants/${driver.tenantId}/dispatch/jobs?limit=100`)
      .then((res) => {
        if (cancelled) return;
        setJobs(
          res.items.filter(
            (j) =>
              j.driverId === driver.linkedDriverId &&
              ["assigned", "in_progress"].includes(j.status),
          ),
        );
        setStale(false);
      })
      .catch(() => {
        if (!cancelled) setStale(true);
      });
    return () => {
      cancelled = true;
    };
  }, [driver.tenantId, driver.linkedDriverId, outboxKey]);

  async function send(job: Job, eventType: string, note?: string) {
    await enqueueWrite({
      tenantId: driver.tenantId,
      label: `${job.reference}: ${eventType}`,
      path: `/tenants/${driver.tenantId}/dispatch/jobs/${job.id}/events`,
      body: note ? { eventType, note } : { eventType },
    });
  }

  function submitNote(job: Job, event: FormEvent) {
    event.preventDefault();
    const text = (notes[job.id] ?? "").trim();
    if (!text) return;
    void send(job, "note", text);
    setNotes((prev) => ({ ...prev, [job.id]: "" }));
  }

  return (
    <section>
      <h1>Tasks</h1>
      {stale ? <p role="status">Offline: job list may be out of date.</p> : null}
      {jobs && jobs.length === 0 ? <p>No jobs assigned to you.</p> : null}
      <ul>
        {(jobs ?? []).map((job) => (
          <li key={job.id}>
            <strong>{job.reference}</strong> for {job.customerName} ({job.priority}),{" "}
            {job.status.replace("_", " ")}
            <div>
              {job.status === "assigned" ? (
                <button type="button" onClick={() => void send(job, "started")}>
                  Start job
                </button>
              ) : null}
              {job.status === "in_progress" ? (
                <>
                  <button type="button" onClick={() => void send(job, "arrived")}>
                    Arrived
                  </button>{" "}
                  <button type="button" onClick={() => void send(job, "delivered")}>
                    Delivered
                  </button>{" "}
                  <button type="button" onClick={() => void send(job, "completed")}>
                    Complete
                  </button>
                  <form onSubmit={(e) => submitNote(job, e)}>
                    <label>
                      Note{" "}
                      <input
                        value={notes[job.id] ?? ""}
                        onChange={(e) =>
                          setNotes((prev) => ({ ...prev, [job.id]: e.target.value }))
                        }
                        maxLength={500}
                      />
                    </label>{" "}
                    <button type="submit">Add note</button>
                  </form>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <OutboxPanel items={outbox.items} />
    </section>
  );
}
