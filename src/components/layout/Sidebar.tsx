"use client";

import { useRouter } from "next/navigation";
import {
  BarChart3,
  Boxes,
  Gauge,
  Menu,
  PackageCheck,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QuantCapabilityId } from "@/lib/quant/capabilities";

const ROLE_MODULES: Array<{
  id: string;
  name: string;
  description: string;
  capabilityId: QuantCapabilityId;
  inputPlaceholder: string;
}> = [
  {
    id: "financial-analysis",
    name: "金融分析",
    description: "自动识别个股、选股、持仓、技术、基本面和回测任务",
    capabilityId: "stock_diagnosis",
    inputPlaceholder:
      "描述你的金融分析需求，例如个股诊断、选股推荐、持仓风险、技术择时、基本面研究或策略回测",
  },
];

interface SidebarProps {
  selectedCapability: QuantCapabilityId;
  onSelectCapability: (id: QuantCapabilityId) => void;
  onOpenTaskDrawer: () => void;
  onShowSettings: () => void;
  /** Mobile only */
  isMobile?: boolean;
  onCloseMobile?: () => void;
}

function Sidebar({
  selectedCapability,
  onSelectCapability,
  onOpenTaskDrawer,
  onShowSettings,
  isMobile = false,
  onCloseMobile,
}: SidebarProps) {
  const router = useRouter();

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r bg-background/95",
        isMobile ? "w-[286px]" : "w-[260px]"
      )}
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onOpenTaskDrawer}
          className="flex items-center gap-2 text-foreground hover:text-primary"
          title="打开任务记录"
        >
          <Menu className="h-4 w-4" />
          <span className="text-sm font-semibold">任务记录</span>
        </button>
        {isMobile && (
          <Button
            type="button"
            onClick={onCloseMobile}
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label="关闭侧栏"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-2 px-2">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground">
            金融入口
          </span>
        </div>

        <div className="space-y-1.5">
          {ROLE_MODULES.map((role) => {
            const active = selectedCapability === role.capabilityId;
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => {
                  onSelectCapability(role.capabilityId);
                  onCloseMobile?.();
                }}
                className={cn(
                  "w-full rounded-md border px-3 py-3 text-left transition-colors",
                  active
                    ? "border-primary/20 bg-primary/10 text-primary"
                    : "border-transparent text-foreground hover:border-border hover:bg-muted/60"
                )}
                title={role.description}
                aria-pressed={active}
              >
                <span
                  className={cn(
                    "text-sm font-semibold",
                    active ? "text-primary" : "text-foreground"
                  )}
                >
                  {role.name}
                </span>
                <p
                  className={cn(
                    "mt-1 text-xs leading-5",
                    active ? "text-primary/80" : "text-muted-foreground"
                  )}
                >
                  {role.description}
                </p>
                {active && (
                  <p className="mt-2 text-[11px] leading-5 text-primary/70">
                    系统会根据问题自动匹配分析模板和数据链路
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Platform navigation */}
      <div className="border-t p-3">
        <Button
          type="button"
          onClick={() => router.push("/eval-platform")}
          variant="ghost"
          className="mb-0.5 w-full justify-start"
        >
          <Gauge className="h-4 w-4" />
          评测平台
        </Button>
        <Button
          type="button"
          onClick={() => router.push("/skills")}
          variant="ghost"
          className="mb-0.5 w-full justify-start"
        >
          <PackageCheck className="h-4 w-4" />
          Skills 管理
        </Button>
        <Button
          type="button"
          onClick={onShowSettings}
          variant="ghost"
          className="w-full justify-start"
        >
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </aside>
  );
}

export { Sidebar, ROLE_MODULES };
export type { SidebarProps };
