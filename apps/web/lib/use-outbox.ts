"use client";

import { useCallback, useEffect, useState } from "react";
import { listItems, type OutboxItem } from "./outbox";
import { flushOutbox, OUTBOX_EVENT } from "./sync";

const SYNC_INTERVAL_MS = 30_000;

/** Live view of this tenant's queued writes. Also retries the queue on load, on reconnect and periodically. */
export function useOutbox(tenantId: string) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [online, setOnline] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setItems((await listItems()).filter((item) => item.tenantId === tenantId));
    } catch {
      setItems([]);
    }
  }, [tenantId]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void refresh();
    void flushOutbox();

    const onOnline = () => {
      setOnline(true);
      void flushOutbox();
    };
    const onOffline = () => setOnline(false);
    const onChange = () => void refresh();
    const timer = window.setInterval(() => void flushOutbox(), SYNC_INTERVAL_MS);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener(OUTBOX_EVENT, onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(OUTBOX_EVENT, onChange);
    };
  }, [refresh]);

  return { items, online, refresh };
}
