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
      icon={<ClipboardList className="h-4 w-4 text-blue-600" />}
      action={
        <Badge variant="outline" className="bg-white text-slate-500">
          {filteredCases.length}/{totalCaseCount}
        </Badge>
      }
    >
      <div className="border-b border-slate-100 p-3">
        <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_220px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={caseKeyword}
              onChange={(event) => onCaseKeywordChange(event.target.value)}
              placeholder="搜索用例、能力、标的..."
              className="h-9 border-slate-200 bg-white pl-9"
            />
          </div>
          <select className={selectClassName} value={selectedCase} onChange={(event) => onSelectedCaseChange(event.target.value)}>
            <option value="all">当前评测集全部</option>
            {selectedEvalSetCases.map((testCase) => (
              <option key={testCase.id} value={testCase.id}>
                {testCase.name}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={onRunSelection} disabled={isStarting}>
            {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            运行选择
          </Button>
        </div>
      </div>

      <div id="cases" className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
            <tr>
              <th className="w-[26%] px-4 py-3">用例名称</th>
              <th className="w-[28%] px-4 py-3">用户 Query</th>
              <th className="w-[17%] px-4 py-3">标签</th>
              <th className="w-[12%] px-4 py-3">预期</th>
              <th className="w-[9%] px-4 py-3">最近结果</th>
              <th className="w-[8%] px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredCases.map((testCase) => {
              const result = latestResultByCase.get(testCase.id) ?? latestResultByCase.get(testCase.name);
              return (
                <tr key={testCase.id} className="border-t border-slate-100 bg-white hover:bg-slate-50/70">
                  <td className="px-4 py-3 align-top">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-blue-700">{testCase.name}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">{testCase.id}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <p className="line-clamp-2 text-slate-600">{testCase.question}</p>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge className="border-blue-100 bg-blue-50 text-blue-700 hover:bg-blue-50">
                        {testCase.capabilityLabel}
                      </Badge>
                      <Badge variant="outline" className="bg-white text-slate-600">
                        {testCase.typeLabel}
                      </Badge>
                      {testCase.tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="bg-white text-slate-500">
                          {tag}
                        </Badge>
                      ))}
                      {testCase.tags.length > 2 && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          +{testCase.tags.length - 2}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="space-y-1 text-xs text-slate-600">
                      <p className="truncate font-mono">{testCase.expectedSymbols.slice(0, 3).join(', ') || '-'}</p>
                      <p className="truncate">{testCase.expectedTemplateId ?? testCase.expectedAssetType ?? '-'}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">{statusPill(result)}</td>
                  <td className="px-4 py-3 text-right align-top">
                    <div className="flex justify-end gap-1.5">
                      {latestRun && result && (
                        <Button variant="ghost" size="icon" asChild>
                          <Link href={`/evals/runs/${latestRun.id}#case-${result.id}`} aria-label="查看报告">
                            <FileText className="h-4 w-4" />
                          </Link>
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => onRunCase(testCase.id)} disabled={isStarting} aria-label="运行用例">
                        <Play className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filteredCases.length && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
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
