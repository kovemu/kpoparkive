"use client";

import { useEffect, useState } from "react";

type Activity = {
  id: string;
  source_title: string;
  summary: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

export default function HomeActivity({ initialItems }: { initialItems: Activity[] }) {
  const [items, setItems] = useState(initialItems);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const response = await fetch("/api/home-activity", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && Array.isArray(data.items)) setItems(data.items);
      } catch {
        // Keep the last successful timeline on transient network failures.
      }
    }

    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!items.length) {
    return <div className="homeEmpty">No edits yet.</div>;
  }

  return (
    <div className="activityList">
      {items.map((item) => {
        const title = item.source_title || "Untitled";
        const encoded = title.split("/").map(encodeURIComponent).join("/");
        const date = new Date(item.created_at);
        return (
          <article className="activityItem" key={item.id}>
            <div className="activityDot" aria-hidden="true" />
            <div className="activityBody">
              <div className="activityTopline">
                <a href={`/w/${encoded}`}>{title}</a>
                <time dateTime={item.created_at}>
                  {date.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p>{item.summary || "Edited the article"}</p>
              <div className="activityMeta">
                <span>{item.display_name || "Anonymous"}</span>
                <span className={`activityStatus status-${item.status}`}>{item.status}</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
