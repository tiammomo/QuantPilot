import Link from 'next/link';
import { ChevronRight, TriangleAlert, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/quant/eval-console-primitives';
import type { QuantEvalRepairTicket, QuantEvalResult, QuantEvalRun } from '@/lib/quant/evals';

type EvalRepairsViewProps = {
  repairTickets: QuantEvalRepairTicket[];
  warningResults: QuantEvalResult[];
  latestRun: QuantEvalRun | null;
};

export function EvalRepairsView({ repairTickets, warningResults, latestRun }: EvalRepairsViewProps) {
  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel
        title="失败修复"
        icon={<Wrench className="h-4 w-4 text-amber-600" />}
        action={
          <Badge variant="outline" className="bg-white text-slate-500">
            {repairTickets.length}
          </Badge>
        }
      >
        <div id="repairs" className="divide-y divide-slate-100">
          {repairTickets.map((ticket) => (
            <div key={ticket.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge className={ticket.severity === 'high' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'}>
                      {ticket.severity === 'high' ? '高' : '中'}
                    </Badge>
                    <Badge variant="outline" className="bg-white text-slate-500">
                      {ticket.status === 'open' ? '待处理' : '已解决'}
                    </Badge>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-medium text-slate-900">{ticket.title}</p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {ticket.caseId} · {ticket.model}
                  </p>
                </div>
                <Button variant="ghost" size="icon" asChild>
                  <Link href={`/evals/runs/${ticket.runId}`} aria-label="查看修复单报告">
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </div>
          ))}
          {!repairTickets.length && <div className="p-8 text-center text-sm text-slate-500">暂无失败修复单。</div>}
        </div>
      </Panel>

      <Panel title="警告用例" icon={<TriangleAlert className="h-4 w-4 text-amber-600" />}>
        <div className="space-y-2 p-4">
          {warningResults.slice(0, 10).map((result) => (
            <Link
              key={result.id}
              href={latestRun ? `/evals/runs/${latestRun.id}#case-${result.id}` : '#'}
              className="block rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
            >
              {result.name}
            </Link>
          ))}
          {!warningResults.length && <p className="py-8 text-center text-sm text-slate-500">暂无警告用例。</p>}
        </div>
      </Panel>
    </section>
  );
}
