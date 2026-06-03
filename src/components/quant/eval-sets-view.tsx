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
      title="评测集"
      icon={<FolderOpen className="h-4 w-4 text-primary" />}
      action={
        <Badge variant="outline" className="text-muted-foreground border-border/40">
          {filteredEvalSets.length}/{evalSets.length}
        </Badge>
      }
    >
      <div className="space-y-4 p-4">
        {/* Search + Filter */}
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={evalSetKeyword}
              onChange={(event) => onEvalSetKeywordChange(event.target.value)}
              placeholder="搜索评测集..."
              className="h-9 border-border/40 bg-card/60 pl-9 text-sm"
            />
          </div>
          <select className={selectClassName} value={evalSetCategoryFilter} onChange={(event) => onEvalSetCategoryFilterChange(event.target.value)}>
            <option value="all">全部分类</option>
            {evalSetCategories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>

        {/* Card grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pagedEvalSets.map((evalSet) => {
            const stats = getEvalSetStats(evalSet, latestResultByCase);
            const isSelected = evalSet.id === selectedEvalSet.id;
            return (
              <div
                key={evalSet.id}
                className={`group relative rounded-xl border p-4 transition-all ${
                  isSelected
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border/30 bg-card/60 hover:border-border/50 hover:bg-card/80'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-semibold ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                      {evalSet.name}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{evalSet.description}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 border-border/40 text-[10px] text-muted-foreground">
                    {evalSet.category}
                  </Badge>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{evalSet.caseIds.length} 个用例</span>
                  <span className={`text-xs font-medium ${stats.passRate === null ? 'text-muted-foreground' : passRateClass(stats.passRate)}`}>
                    {stats.passRate === null ? '未运行' : `${stats.passRate}%`}
                  </span>
                </div>

                <div className="mt-3 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5 border-border/40 text-xs"
                    onClick={() => onEvalSetSelect(evalSet.id)}
                  >
                    选择
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 gap-1.5 text-xs"
                    onClick={onRunSelectedEvalSet}
                    disabled={isStarting}
                  >
                    {isStarting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    运行
                  </Button>
                </div>
              </div>
            );
          })}
          {!pagedEvalSets.length && (
            <div className="col-span-full rounded-xl border border-dashed border-border/40 p-10 text-center text-sm text-muted-foreground">
              没有匹配的评测集。
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-border/30 pt-3 text-sm text-muted-foreground">
          <span className="text-xs">
            第 {Math.min(evalSetPage, evalSetPageCount)} / {evalSetPageCount} 页 · 每页 {EVAL_SET_PAGE_SIZE} 个
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEvalSetPageChange((page) => Math.max(1, page - 1))}
              disabled={evalSetPage <= 1}
              className="border-border/40 text-xs"
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEvalSetPageChange((page) => Math.min(evalSetPageCount, page + 1))}
              disabled={evalSetPage >= evalSetPageCount}
              className="border-border/40 text-xs"
            >
              下一页
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
