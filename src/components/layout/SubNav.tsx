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
  className?: string;
}

function SubNav({ items, activeId, onChange, actions, compactOnMobile = false, className }: SubNavProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeId]);

  return (
    <nav
      className={cn(
        "sticky top-0 z-30 flex items-center gap-2 border-b border-border/75 bg-background/82 px-4 shadow-[0_8px_24px_-24px_hsl(var(--foreground)/0.45)] backdrop-blur-xl lg:px-6",
        className
      )}
    >
      <div className="platform-nav-scroll flex h-12 min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
        {items.map((item) => {
          const isActive = item.id === activeId;
          const isDisabled = item.disabled;

          return (
            <button
              key={item.id}
              ref={isActive ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-disabled={isDisabled}
              disabled={isDisabled}
              title={isDisabled ? item.tooltip : compactOnMobile ? item.label : undefined}
              onClick={() => {
                if (!isDisabled) onChange(item.id);
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
export type { SubNavProps, SubNavItem };
