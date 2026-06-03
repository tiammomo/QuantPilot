import Link from 'next/link';
import { ClipboardList, FileText, Loader2, Play, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, selectClassName, statusPill } from '@/components/quant/eval-console-primitives';
import type { QuantEvalCase, QuantEvalResult, QuantEvalRun } from '@/lib/quant/evals';

type EvalCasesViewProps = {
  caseKeyword: string;
  selectedCase: string;
  totalCaseCount: number;
  filteredCases: QuantEvalCase[];
  selectedEvalSetCases: QuantEvalCase[];
  latestRun: QuantEvalRun | null;
  latestResultByCase: Map<string, QuantEvalResult>;
  isStarting: boolean;
  onCaseKeywordChange: (keyword: string) => void;
  onSelectedCaseChange: (caseId: string) => void;
  onRunSelection: () => void;
  onRunCase: (caseId: string) => void;
};

export function EvalCasesView({
  caseKeyword,
  selectedCase,
  totalCaseCount,
  filteredCases,
  selectedEvalSetCases,
  latestRun,
  latestResultByCase,
  isStarting,
  onCaseKeywordChange,
  onSelectedCaseChange,
  onRunSelection,
  onRunCase,
}: EvalCasesViewProps) {
  return (
    <Panel
      title="测试用例"
      icon={<ClipboardList className="h-4 w-4 text-primary" />}
      action={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-muted-foreground border-border/40">
            {filteredCases.length}/{totalCaseCount}
          </Badge>
          <Button variant="outline" size="sm" onClick={onRunSelection} disabled={isStarting} className="gap-1.5 border-border/40 text-xs">
            {isStarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            运行已选
          </Button>
          <Button size="sm" onClick={onRunSelection} disabled={isStarting} className="gap-1.5 text-xs">
            {isStarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            运行全部
          </Button>
        </div>
      }
    >
      <div className="border-b border-border/30 p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_180px_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={caseKeyword}
              onChange={(event) => onCaseKeywordChange(event.target.value)}
              placeholder="搜索用例、能力、标的..."
              className="h-9 border-border/40 bg-card/60 pl-9 text-sm"
            />
          </div>
          <select className={selectClassName}>
            <option value="all">全部类型</option>
            {Array.from(new Set(selectedEvalSetCases.map((c) => c.typeLabel))).map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <select className={selectClassName}>
            <option value="all">全部能力</option>
            {Array.from(new Set(selectedEvalSetCases.map((c) => c.capabilityLabel))).map((cap) => (
              <option key={cap} value={cap}>{cap}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border/30 text-left text-xs font-medium text-muted-foreground">
              <th className="px-4 py-3">用例</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">能力</th>
              <th className="px-4 py-3">预期标的</th>
              <th className="px-4 py-3">标签</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredCases.map((testCase) => {
              const result = latestResultByCase.get(testCase.id) ?? latestResultByCase.get(testCase.name);
              return (
                <tr key={testCase.id} className="border-b border-border/20 transition-colors hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{testCase.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{testCase.id}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="border-border/40 text-xs text-muted-foreground">
                      {testCase.typeLabel}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="border-primary/20 bg-primary/10 text-xs text-primary">
                      {testCase.capabilityLabel}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-foreground/70">{testCase.expectedSymbols.slice(0, 3).join(', ') || '-'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {testCase.tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="border-border/40 text-[10px] text-muted-foreground">
                          {tag}
                        </Badge>
                      ))}
                      {testCase.tags.length > 2 && (
                        <span className="text-[10px] text-muted-foreground">+{testCase.tags.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {latestRun && result && (
                        <Button variant="ghost" size="icon" asChild className="h-7 w-7">
                          <Link href={`/eval-platform/runs/${latestRun.id}#case-${result.id}`}>
                            <FileText className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => onRunCase(testCase.id)} disabled={isStarting} className="h-7 w-7">
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filteredCases.length && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  没有匹配的测试用例。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
