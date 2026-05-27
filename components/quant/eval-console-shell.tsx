import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarClock, Loader2, Play, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { EvalView } from '@/components/quant/eval-console-primitives';

export type EvalNavItem = {
  view: EvalView;
  label: string;
  icon: ReactNode;
};

export type EvalViewMeta = {
  title: string;
  badge: string;
  helper: string;
};

export function EvalConsoleShell({
  activeView,
  navItems,
  activeNavItem,
  currentMeta,
  toast,
  isRefreshing,
  isStarting,
  onViewChange,
  onRefresh,
  onCheckSchedule,
  onStart,
  children,
}: {
  activeView: EvalView;
  navItems: EvalNavItem[];
  activeNavItem: EvalNavItem;
  currentMeta: EvalViewMeta;
  toast: { type: 'success' | 'error'; message: string } | null;
  isRefreshing: boolean;
  isStarting: boolean;
  onViewChange: (view: EvalView) => void;
  onRefresh: () => void;
  onCheckSchedule: () => void;
  onStart: () => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f6f7fb] text-slate-900">
      <div className="flex min-h-screen">
        <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
          <div className="flex h-16 items-center gap-3 border-b border-slate-100 px-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-sm font-semibold text-white">
              Q
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">QuantEval</p>
              <p className="text-xs text-slate-500">评测控制台</p>
            </div>
          </div>
          <nav className="space-y-1 px-3 py-4 text-sm">
            {navItems.map((item) => (
              <button
                key={item.view}
                type="button"
                onClick={() => onViewChange(item.view)}
                className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-left transition ${
                  activeView === item.view
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-blue-700'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t border-slate-100 p-4">
            <Button variant="outline" className="w-full justify-start" asChild>
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                返回首页
              </Link>
            </Button>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 lg:px-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <Button variant="ghost" size="icon" asChild className="md:hidden">
                    <Link href="/" aria-label="返回首页">
                      <ArrowLeft className="h-5 w-5" />
                    </Link>
                  </Button>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="hidden text-blue-600 md:inline-flex">{activeNavItem.icon}</span>
                      <h1 className="shrink-0 text-xl font-semibold tracking-normal text-slate-950">{currentMeta.title}</h1>
                      <Badge variant="outline" className="bg-white text-slate-500">
                        {currentMeta.badge}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {currentMeta.helper}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing}>
                  <RefreshCcw className={isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  <span className="hidden sm:inline">刷新</span>
                </Button>
                <Button variant="outline" size="sm" onClick={onCheckSchedule}>
                  <CalendarClock className="h-4 w-4" />
                  <span className="hidden sm:inline">检查定时</span>
                </Button>
                <Button size="sm" className="bg-blue-600 text-white hover:bg-blue-700" onClick={onStart} disabled={isStarting}>
                  {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  <span className="hidden sm:inline">启动评测</span>
                </Button>
              </div>
            </div>
            <div className="border-t border-slate-100 px-3 py-2 md:hidden">
              <div className="flex gap-2 overflow-x-auto">
                {navItems.map((item) => (
                  <button
                    key={item.view}
                    type="button"
                    onClick={() => onViewChange(item.view)}
                    className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${
                      activeView === item.view
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-white text-slate-600'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className="space-y-5 px-4 py-5 lg:px-6">
            {toast && (
              <div
                className={`rounded-md border px-4 py-3 text-sm shadow-sm ${
                  toast.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}
              >
                {toast.message}
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
