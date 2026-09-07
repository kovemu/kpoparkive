"use client";

import React, { createContext, useContext, useMemo, useState } from "react";

type TabContextValue = {
  isSelected: (group: string, key: string) => boolean;
  select: (group: string, key: string) => void;
};

const NamuTabContext = createContext<TabContextValue | null>(null);

function defaultKey(group: string) {
  if (group === "tab") return "tab-a";
  return `${group}-1`;
}

export function NamuTabProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Record<string, string>>({ tab: "tab-a" });

  const value = useMemo<TabContextValue>(() => ({
    isSelected(group, key) {
      return (selected[group] || defaultKey(group)) === key;
    },
    select(group, key) {
      setSelected((current) => current[group] === key ? current : { ...current, [group]: key });
    },
  }), [selected]);

  return <NamuTabContext.Provider value={value}>{children}</NamuTabContext.Provider>;
}

export function useNamuTabs() {
  return useContext(NamuTabContext);
}
