"use client";

import { useState } from "react";
import { Pencil, Search, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { Project as ProjectSummary } from "@/types/project";

interface TaskDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectSummary[];
  editingProject: ProjectSummary | null;
  onEditProject: (project: ProjectSummary | null) => void;
  onUpdateProject: (projectId: string, name: string) => void;
  onOpenProject: (project: ProjectSummary) => void;
  onDeleteProject: (project: ProjectSummary) => void;
  onSearchChange?: (query: string) => void;
  formatTime: (date: string | null) => string;
  formatCliInfo: (cli?: string, model?: string) => string;
  getCapabilityShortName: (capabilityId?: string | null) => string;
}

function TaskDrawer({
  open,
  onOpenChange,
  projects,
  editingProject,
  onEditProject,
  onUpdateProject,
  onOpenProject,
  onDeleteProject,
  formatTime,
  formatCliInfo,
  getCapabilityShortName,
}: TaskDrawerProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? projects.filter((p) => {
        const kw = search.toLowerCase();
        return [p.name, p.description, p.initialPrompt]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(kw));
      })
    : projects;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-[min(420px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden border-r border-border/70 bg-background p-0 sm:max-w-none">
        <SheetHeader className="border-b border-border/70 bg-background px-4 py-4">
          <div className="flex items-baseline gap-1.5">
            <SheetTitle className="text-base">任务记录</SheetTitle>
            <SheetDescription className="text-xs">({projects.length})</SheetDescription>
          </div>
        </SheetHeader>

        <div className="border-b border-border/60 bg-muted/35 px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索任务记录"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话标题..."
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <EmptyState
              title="暂无匹配的任务记录"
              description={search ? "尝试其他关键词" : "创建第一个任务开始使用"}
              className="m-4 border-0"
            />
          ) : (
            filtered.map((project) => {
              const isEditing = editingProject?.id === project.id;
              const title = project.name || project.initialPrompt || "未命名任务";
              const capabilityName = getCapabilityShortName(project.quantCapabilityId);

              return (
                <div
                  key={project.id}
                  className="task-drawer-row group relative border-b border-border/55 px-4 py-3 transition-colors hover:bg-muted/45 focus-within:bg-muted/45"
                >
                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const name = String(fd.get("name") || "").trim();
                        if (name) onUpdateProject(project.id, name);
                      }}
                      className="space-y-2"
                    >
                      <input
                        aria-label={`重命名任务：${title}`}
                        name="name"
                        defaultValue={title}
                        autoFocus
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm outline-none focus:ring-1 focus:ring-ring"
                        onKeyDown={(e) => {
                          if (e.key === "Escape") onEditProject(null);
                        }}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          onClick={() => onEditProject(null)}
                          size="sm"
                          variant="outline"
                          className="h-8"
                        >
                          取消
                        </Button>
                        <Button type="submit" size="sm" className="h-8">
                          保存
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          onOpenProject(project);
                        }}
                        className="block min-h-11 w-full min-w-0 pr-24 text-left"
                      >
                        <p className="truncate text-sm font-semibold text-foreground">
                          {title}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{formatTime(project.lastMessageAt || project.createdAt)}</span>
                          <span>@{project.id.slice(-8)}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground/75">
                          {capabilityName} ·{" "}
                          {formatCliInfo(
                            project.preferredCli ?? undefined,
                            project.selectedModel ?? undefined
                          )}
                        </p>
                      </button>
                      <div className="task-drawer-actions absolute right-3 top-2 z-10 flex gap-1 transition-opacity">
                        <button
                          type="button"
                          onClick={() => onEditProject(project)}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-primary focus-visible:bg-background focus-visible:text-primary"
                          aria-label={`重命名任务：${title}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteProject(project)}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-red-500 focus-visible:bg-background focus-visible:text-red-500"
                          aria-label={`删除任务：${title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { TaskDrawer };
export type { TaskDrawerProps };
