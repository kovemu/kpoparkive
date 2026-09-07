"use client";

import React, { createContext, useContext, useMemo, useState } from "react";

type TabContextValue = {
  isSelected: (group: string, key: string) => boolean;
  select: (group: string, key: string) => void;
};

const NamuTabContext = createContext<TabContextValue | null>(null);

function tabGroup(key: string) {
  return key.replace(/-[^-]+$/, "");
}

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

export function NamuTabControl({ tabKey, label, className, style }: { tabKey: string; label: string; className?: string; style?: React.CSSProperties }) {
  const tabs = useContext(NamuTabContext);
  const group = tabGroup(tabKey);
  const active = tabs?.isSelected(group, tabKey) ?? defaultKey(group) === tabKey;
  const isSubtab = /-\d+$/i.test(tabKey);
  const stateClassName = [className, active ? "selected" : ""].filter(Boolean).join(" ");

  return <button
    type="button"
    className={stateClassName}
    data-namu-tab-control={tabKey}
    data-namu-tab-active={active ? "true" : "false"}
    aria-pressed={active}
    onClick={() => tabs?.select(group, tabKey)}
    style={{
      appearance: "none",
      border: 0,
      cursor: "pointer",
      font: "inherit",
      flex: isSubtab ? "1 1 38%" : "1 1 20%",
      minWidth: isSubtab ? 120 : 110,
      margin: "4px 8px",
      padding: isSubtab ? "5px 14px" : "6px 14px",
      borderRadius: 8,
      background: active ? "#fff" : "rgba(255,255,255,.18)",
      color: active ? "var(--namu-theme-bg, var(--accent, #fc6fcf))" : "inherit",
      textAlign: "center",
      fontWeight: 700,
      lineHeight: 1.25,
      ...style,
    }}
  >{label}</button>;
}

export function NamuTabContent({ tabKey, className, style, children }: { tabKey: string; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const tabs = useContext(NamuTabContext);
  const group = tabGroup(tabKey);
  const active = tabs?.isSelected(group, tabKey) ?? defaultKey(group) === tabKey;
  if (!active) return null;
  const stateClassName = [className, "selected"].filter(Boolean).join(" ");
  return <div className={stateClassName} style={style} data-namu-tab-content={tabKey}>{children}</div>;
}

export function useNamuTabs() {
  return useContext(NamuTabContext);
}
