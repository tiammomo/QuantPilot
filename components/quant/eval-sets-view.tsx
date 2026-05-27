import { FolderOpen, Loader2, Play, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  EVAL_SET_PAGE_SIZE,
  Panel,
  getEvalSetStats,
  passRateClass,
  selectClassName,
  type EvalSet,
} from '@/components/quant/eval-console-primitives';
import type { QuantEvalResult } from '@/lib/quant/evals';

type EvalSetStats = {
  ran: number;
  passed: number;
  failed: number;
  passRate: number | null;
};

type EvalSetsViewProps = {
  evalSets: EvalSet[];
  filteredEvalSets: EvalSet[];
  pagedEvalSets: EvalSet[];
  selectedEvalSet: EvalSet;
  selectedEvalSetStats: EvalSetStats;
  latestResultByCase: Map<string, QuantEvalResult>;
  evalSetKeyword: string;
  evalSetCategoryFilter: string;
  evalSetCategories: string[];
  evalSetPage: number;
  evalSetPageCount: number;
  isStarting: boolean;
  onEvalSetKeywordChange: (keyword: string) => void;
  onEvalSetCategoryFilterChange: (category: string) => void;
  onEvalSetSelect: (evalSetId: string) => void;
  onEvalSetPageChange: (updater: (page: number) => number) => void;
  onRunSelectedEvalSet: () => void;
};

export function EvalSetsView({
  evalSets,
  filteredEvalSets,
  pagedEvalSets,
  selectedEvalSet,
  selectedEvalSetStats,
  latestResultByCase,
  evalSetKeyword,
  evalSetCategoryFilter,
  evalSetCategories,
  evalSetPage,
  evalSetPageCount,
  isStarting,
  onEvalSetKeywordChange,
  onEvalSetCategoryFilterChange,
  onEvalSetSelect,
  onEvalSetPageChange,
  onRunSelectedEvalSet,
}: EvalSetsViewProps) {
  return (
    <Panel
      title="评测集管理"
      icon={<FolderOpen className="h-4 w-4 text-blue-600" />}
      action={
        <Badge variant="outline" className="bg-white text-slate-500">
          {filteredEvalSets.length}/{evalSets.length}
        </Badge>
      }
    >
      <div id="eval-sets" className="grid gap-4 p-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="rounded-md border border-blue-100 bg-blue-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-base font-semibold text-blue-950">{selectedEvalSet.name}</p>
                <Badge className="border-blue-200 bg-white text-blue-700 hover:bg-white">
                  {selectedEvalSet.category}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-blue-700">{selectedEvalSet.description}</p>
            </div>
            <span className="shrink-0 rounded bg-white px-2 py-1 text-xs font-semibold text-blue-700">
              {selectedEvalSet.caseIds.length} 例
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md bg-white/80 p-3">
              <p className="text-blue-500">已跑</p>
              <p className="mt-1 font-semibold text-blue-950">{selectedEvalSetStats.ran}</p>
            </div>
            <div className="rounded-md bg-white/80 p-3">
              <p className="text-blue-500">失败</p>
              <p className={selectedEvalSetStats.failed ? 'mt-1 font-semibold text-red-600' : 'mt-1 font-semibold text-blue-950'}>
                {selectedEvalSetStats.failed}
              </p>
            </div>
            <div className="rounded-md bg-white/80 p-3">
              <p className="text-blue-500">通过率</p>
              <p className={`mt-1 font-semibold ${selectedEvalSetStats.passRate === null ? 'text-blue-950' : passRateClass(selectedEvalSetStats.passRate)}`}>
                {selectedEvalSetStats.passRate === null ? '-' : `${selectedEvalSetStats.passRate}%`}
              </p>
            </div>
          </div>
          <Button className="mt-4 w-full bg-blue-600 text-white hover:bg-blue-700" onClick={onRunSelectedEvalSet} disabled={isStarting}>
            {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            运行当前评测集
          </Button>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_160px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={evalSetKeyword}
                onChange={(event) => onEvalSetKeywordChange(event.target.value)}
                placeholder="搜索评测集、用例 id..."
                className="h-9 border-slate-200 bg-white pl-9"
              />
            </div>
            <select className={selectClassName} value={evalSetCategoryFilter} onChange={(event) => onEvalSetCategoryFilterChange(event.target.value)}>
              <option value="all">全部分类</option>
              {evalSetCategories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pagedEvalSets.map((evalSet) => {
              const stats = getEvalSetStats(evalSet, latestResultByCase);
              const isSelected = evalSet.id === selectedEvalSet.id;
              return (
                <button
                  key={evalSet.id}
                  type="button"
                  className={`min-h-28 rounded-md border px-3 py-3 text-left transition ${
                    isSelected ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-100 hover:bg-slate-50'
                  }`}
                  onClick={() => onEvalSetSelect(evalSet.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={isSelected ? 'truncate text-sm font-semibold text-blue-800' : 'truncate text-sm font-medium text-slate-900'}>
                        {evalSet.name}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{evalSet.description}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 bg-white text-slate-500">
                      {evalSet.category}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                    <span>{evalSet.caseIds.length} 个用例</span>
                    <span>{stats.passRate === null ? '未运行' : `${stats.passRate}%`}</span>
                  </div>
                </button>
              );
            })}
            {!pagedEvalSets.length && (
              <div className="rounded-md border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
                没有匹配的评测集。
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span>
              第 {Math.min(evalSetPage, evalSetPageCount)} / {evalSetPageCount} 页 · 每页 {EVAL_SET_PAGE_SIZE} 组
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEvalSetPageChange((page) => Math.max(1, page - 1))}
                disabled={evalSetPage <= 1}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEvalSetPageChange((page) => Math.min(evalSetPageCount, page + 1))}
                disabled={evalSetPage >= evalSetPageCount}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
