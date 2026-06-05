"use client";

import { useRouter } from "next/navigation";
import {
  Database,
  Map,
  Menu,
  Settings,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TravelCapabilityId } from "@/lib/travel/capabilities";

const ROLE_MODULES: Array<{
  id: string;
  name: string;
  description: string;
  capabilityId: TravelCapabilityId;
  inputPlaceholder: string;
}> = [
  {
    id: "mixed-food-route",
    name: "餐饮文化混排",
    description: "组合餐饮、文化和娱乐 POI，兼顾预算、排队和步行",
    capabilityId: "mixed_food_route",
    inputPlaceholder: "前门附近玩4小时，中午吃饭，想吃好但不想排队，预算200以内，少走路",
  },
  {
    id: "culture-route",
    name: "北京文化路线",
    description: "串联博物馆、古建、剧场和美术馆，生成可执行路线",
    capabilityId: "culture_route",
    inputPlaceholder: "故宫附近安排4小时文化路线，少走路，预算100以内，不吃饭",
  },
  {
    id: "family-low-queue",
    name: "亲子低排队",
    description: "提高亲子友好、环境质量和低排队 UGC 信号权重",
    capabilityId: "family_low_queue",
    inputPlaceholder: "带孩子在什刹海附近轻松玩，安排吃饭，不想排队",
  },
  {
    id: "budget-route",
    name: "预算优先",
    description: "在预算上限内保留高性价比、低成本 POI",
    capabilityId: "budget_route",
    inputPlaceholder: "预算100以内，前门附近吃逛路线，尽量不排队",
  },
  {
    id: "efficient-route",
    name: "效率优先",
    description: "优先缩短转移距离和总时长，降低回头路",
    capabilityId: "efficient_route",
    inputPlaceholder: "天坛附近3小时高效串联3个点，少走路",
  },
  {
    id: "replan-compare",
    name: "动态重规划",
    description: "基于上一轮路线追加、删除、替换或保留地点",
    capabilityId: "replan_compare",
    inputPlaceholder: "预算降到100，保留第一个点，重新规划",
  },
];

interface SidebarProps {
  selectedCapability: TravelCapabilityId;
  onSelectCapability: (id: TravelCapabilityId) => void;
  onOpenTaskDrawer: () => void;
  onShowSettings: () => void;
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
        "flex h-full flex-col border-r border-[#ead8c3] bg-[#fffaf2]/98",
        isMobile ? "w-[310px]" : "w-[280px]",
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-[#ead8c3] px-4">
        <button
          type="button"
          onClick={onOpenTaskDrawer}
          className="flex items-center gap-2 text-[#24140f] hover:text-[#b73522]"
          title="打开任务记录"
        >
          <Menu className="h-4 w-4" />
          <span className="text-base font-black">任务记录</span>
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

      <div className="flex-1 overflow-y-auto px-3 py-5">
        <div className="mb-2 px-2">
          <span className="text-sm font-black tracking-wide text-[#7a513c]">
            北京旅游核心能力
          </span>
        </div>

        <div className="space-y-2">
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
                  "w-full rounded-2xl border px-4 py-4 text-left transition-colors",
                  active
                    ? "border-[#e7a6a0] bg-[#fff0ef] text-[#b73522] shadow-sm"
                    : "border-transparent text-[#24140f] hover:border-[#ead8c3] hover:bg-white",
                )}
                title={role.description}
                aria-pressed={active}
              >
                <span className={cn("text-base font-black", active ? "text-[#b73522]" : "text-[#24140f]")}>
                  {role.name}
                </span>
                <p className={cn("mt-2 text-sm leading-6", active ? "text-[#b73522]/85" : "text-[#385070]")}>
                  {role.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-[#ead8c3] p-3">
        <Button type="button" onClick={() => router.push("/data-platform")} variant="ghost" className="mb-0.5 w-full justify-start">
          <Database className="h-4 w-4" />
          POI/UGC 数据
        </Button>
        <Button type="button" onClick={() => router.push("/")} variant="ghost" className="mb-0.5 w-full justify-start">
          <Map className="h-4 w-4" />
          回到首页
        </Button>
        <Button type="button" onClick={onShowSettings} variant="ghost" className="w-full justify-start">
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </div>
    </aside>
  );
}

export { Sidebar, ROLE_MODULES };
export type { SidebarProps };
