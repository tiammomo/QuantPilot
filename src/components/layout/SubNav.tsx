"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SubNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  tooltip?: string;
}

interface SubNavProps {
  items: SubNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  actions?: ReactNode;
  /** Show only the active label on narrow screens to preserve room for actions. */
  compactOnMobile?: boolean;
  /** Accessible label used by the tab list. */
  ariaLabel?: string;
  className?: string;
}

function tabId(itemId: string) {
  return `subnav-tab-${itemId}`;
}

function panelId(itemId: string) {
  return `subnav-panel-${itemId}`;
}

function SubNav({ items, activeId, onChange, actions, compactOnMobile = false, ariaLabel = "页面视图", className }: SubNavProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeId]);

  const moveFocus = (currentId: string, direction: "next" | "previous" | "first" | "last") => {
    const enabled = items.filter((item) => !item.disabled);
    if (!enabled.length) return;
    const currentIndex = Math.max(0, enabled.findIndex((item) => item.id === currentId));
    const nextItem = direction === "first"
      ? enabled[0]
      : direction === "last"
        ? enabled.at(-1)
        : enabled[(currentIndex + (direction === "next" ? 1 : -1) + enabled.length) % enabled.length];
    if (!nextItem) return;
    onChange(nextItem.id);
    window.requestAnimationFrame(() => document.getElementById(tabId(nextItem.id))?.focus());
  };

  return (
    <nav
      className={cn(
        "sticky top-0 z-30 flex items-center gap-2 border-b border-border/75 bg-background/82 px-4 shadow-[0_8px_24px_-24px_hsl(var(--foreground)/0.45)] backdrop-blur-xl lg:px-6",
        className
      )}
    >
      <div className="platform-nav-scroll flex h-12 min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
        {items.map((item) => {
          const isActive = item.id === activeId;
          const isDisabled = item.disabled;

          return (
            <button
              key={item.id}
              ref={isActive ? activeTabRef : undefined}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-controls={panelId(item.id)}
              aria-selected={isActive}
              aria-disabled={isDisabled}
              tabIndex={isActive && !isDisabled ? 0 : -1}
              disabled={isDisabled}
              title={isDisabled ? item.tooltip : compactOnMobile ? item.label : undefined}
              onClick={() => {
                if (!isDisabled) onChange(item.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveFocus(item.id, "next");
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveFocus(item.id, "previous");
                } else if (event.key === "Home") {
                  event.preventDefault();
                  moveFocus(item.id, "first");
                } else if (event.key === "End") {
                  event.preventDefault();
                  moveFocus(item.id, "last");
                }
              }}
              className={cn(
                "relative flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-all",
                compactOnMobile && !isActive && "max-[639px]:gap-0 max-[639px]:px-2.5",
                isActive && !isDisabled
                  ? "bg-primary/10 text-primary shadow-sm ring-1 ring-primary/15"
                  : isDisabled
                    ? "cursor-not-allowed text-muted-foreground/45"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              )}
            >
              <span className={cn("h-4 w-4", isDisabled && "opacity-40")}>{item.icon}</span>
              <span className={cn("whitespace-nowrap", compactOnMobile && !isActive && "max-[639px]:sr-only")}>{item.label}</span>
              {isDisabled && item.tooltip && (
                <span className="hidden rounded-full border border-border bg-muted px-1.5 py-0 text-[10px] text-muted-foreground group-hover:inline-block sm:inline-block">
                  {item.tooltip}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </nav>
  );
}

export { SubNav };
export { panelId as subNavPanelId, tabId as subNavTabId };
export type { SubNavProps, SubNavItem };
