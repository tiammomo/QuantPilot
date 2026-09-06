"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { StrategyDashboardData, StrategyFactorCatalogItem } from '@/lib/quant/strategy-types';

function factorCatalogStatusLabel(status: StrategyFactorCatalogItem["status"]) {
  if (status === "ready") return "可计算";
  if (status === "partial") return "部分可用";
  return "需补数据";
}
function factorCatalogStatusClass(status: StrategyFactorCatalogItem["status"]) {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function factorDirectionLabel(direction: StrategyFactorCatalogItem["direction"]) {
  if (direction === "higher_is_better") return "越高越好";
  if (direction === "lower_is_better") return "越低越好";
  if (direction === "middle_is_better") return "适中最好";
  return "事件驱动";
}

const FACTOR_PAGE_SIZE = 4;
type FactorStatusFilter = "all" | StrategyFactorCatalogItem["status"];

const FACTOR_STATUS_FILTERS: Array<{ id: FactorStatusFilter; label: string }> = [
  { id: "all", label: "全部质量" },
  { id: "ready", label: "可计算" },
  { id: "partial", label: "部分可用" },
  { id: "needs_data", label: "需补数据" },
];

export function FactorCatalogView({ data }: { data: StrategyDashboardData }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<FactorStatusFilter>("all");
  const [factorPage, setFactorPage] = useState(1);
  const factorEntries = useMemo(() => (
    data.factorCatalog.categories.flatMap((category) => (
      category.factors.map((factor) => ({
        category,
        factor,
      }))
    ))
  ), [data.factorCatalog.categories]);
  const allFactors = factorEntries.map((entry) => entry.factor);
  const filteredEntries = useMemo(() => (
    factorEntries.filter(({ category, factor }) => (
      (categoryFilter === "all" || category.id === categoryFilter) &&
      (statusFilter === "all" || factor.status === statusFilter)
    ))
  ), [categoryFilter, factorEntries, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / FACTOR_PAGE_SIZE));
  const safePage = Math.min(factorPage, totalPages);
  const pageStart = (safePage - 1) * FACTOR_PAGE_SIZE;
  const pageEntries = filteredEntries.slice(pageStart, pageStart + FACTOR_PAGE_SIZE);
  const pagedCategoryGroups = data.factorCatalog.categories
    .map((category) => ({
      category,
      factors: pageEntries
        .filter((entry) => entry.category.id === category.id)
        .map((entry) => entry.factor),
      total: filteredEntries.filter((entry) => entry.category.id === category.id).length,
    }))
    .filter((group) => group.factors.length > 0);
  const readyCount = allFactors.filter((factor) => factor.status === "ready").length;
  const partialCount = allFactors.filter((factor) => factor.status === "partial").length;
  const needsDataCount = allFactors.filter((factor) => factor.status === "needs_data").length;
  const topPriorityFactors = allFactors
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 6);
  const sourceFrameworks = Array.from(new Set(allFactors.flatMap((factor) => factor.sourceFrameworks))).slice(0, 12);
  const pageEnd = filteredEntries.length ? Math.min(pageStart + pageEntries.length, filteredEntries.length) : 0;

  useEffect(() => {
    setFactorPage(1);
  }, [categoryFilter, statusFilter]);

  useEffect(() => {
    if (factorPage > totalPages) setFactorPage(totalPages);
  }, [factorPage, totalPages]);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">因子目录</h2>
              <Badge variant="outline" className="bg-white text-slate-500">{allFactors.length} 个因子</Badge>
              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{readyCount} 个可计算</Badge>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              因子目录记录策略平台已经沉淀的因子公式、数据依赖、适用场景和补数缺口。它用于连接股票池、策略模板、回测和后续自动选股。
            </p>
          </div>
          <div className="grid min-w-[320px] grid-cols-3 gap-2">
            {[
              { label: "可计算", value: readyCount, className: "text-emerald-700" },
              { label: "部分可用", value: partialCount, className: "text-amber-700" },
              { label: "需补数据", value: needsDataCount, className: "text-blue-700" },
            ].map((item) => (
              <div key={item.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className={cn("mt-1 text-xl font-bold tabular-nums", item.className)}>{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-sm font-semibold text-slate-950">研究方法</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {data.factorCatalog.methodology.map((item) => (
                <div key={item} className="flex gap-2 rounded-md bg-white px-3 py-2 text-sm leading-6 text-slate-600">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-blue-100 bg-blue-50/70 p-4">
            <p className="text-sm font-semibold text-blue-950">参考框架</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {sourceFrameworks.map((framework) => (
                <Badge key={framework} variant="outline" className="border-blue-100 bg-white text-blue-700">
                  {framework}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">数据 → 因子 → 策略</h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              研究顺序固定为先确认数据，再设计因子，最后组合策略；任何一步质量门没过，都不进入下一步。
            </p>
          </div>
          <Badge variant="outline" className="bg-white text-slate-500">研究协议</Badge>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {data.factorCatalog.workflow.map((step) => (
            <article key={step.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-md bg-white px-2.5 py-1 font-mono text-xs font-semibold text-blue-700 shadow-sm">
                  {step.stage}
                </span>
                <span className="text-xs font-medium text-slate-400">{step.id}</span>
              </div>
              <h4 className="mt-3 text-sm font-bold text-slate-950">{step.title}</h4>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.objective}</p>
              <div className="mt-3 grid gap-2">
                <div>
                  <p className="text-[11px] font-semibold text-slate-400">输入</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{step.inputs.join("、")}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-slate-400">输出</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{step.outputs.join("、")}</p>
                </div>
                <div className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2">
                  <p className="text-[11px] font-semibold text-amber-700">质量门</p>
                  <p className="mt-1 text-xs leading-5 text-amber-900">{step.qualityGate}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(420px,0.8fr)]">
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">从数据层思考因子</h3>
              <p className="mt-1 text-sm text-slate-500">每个数据层都要明确能直接产出哪些因子，以及当前还缺什么。</p>
            </div>
            <Badge variant="outline" className="bg-white text-slate-500">{data.factorCatalog.dataLayers.length} 层</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">数据层</th>
                  <th className="px-4 py-3 font-medium">现有数据</th>
                  <th className="px-4 py-3 font-medium">可派生因子</th>
                  <th className="px-4 py-3 font-medium">缺口与动作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.factorCatalog.dataLayers.map((layer) => (
                  <tr key={layer.id} className="align-top">
                    <td className="w-[220px] px-4 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-950">{layer.name}</p>
                        <Badge variant="outline" className={factorCatalogStatusClass(layer.status)}>
                          {factorCatalogStatusLabel(layer.status)}
                        </Badge>
                        <Badge variant="outline" className="bg-white text-slate-500">{layer.priority}</Badge>
                      </div>
                      <div className="mt-2 space-y-1">
                        {layer.tables.map((table) => (
                          <code key={`${layer.id}-${table}`} className="block rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                            {table}
                          </code>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {layer.availableData.map((item) => (
                          <span key={`${layer.id}-available-${item}`} className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {layer.factorIdeas.map((item) => (
                          <span key={`${layer.id}-factor-${item}`} className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {layer.dataGaps.map((item) => (
                            <span key={`${layer.id}-gap-${item}`} className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                              {item}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs leading-5 text-slate-500">{layer.nextAction}</p>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-slate-950">由因子组合策略</h3>
            <p className="mt-1 text-sm text-slate-500">策略先作为蓝图存在，验证通过后再进入策略目录。</p>
          </div>
          <div className="max-h-[640px] space-y-3 overflow-y-auto p-4">
            {data.factorCatalog.strategyBlueprints.map((blueprint) => (
              <article key={blueprint.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-slate-950">{blueprint.name}</h4>
                    <p className="mt-1 text-xs text-slate-400">{blueprint.horizon}</p>
                  </div>
                  <Badge variant="outline" className={factorCatalogStatusClass(blueprint.status)}>
                    {factorCatalogStatusLabel(blueprint.status)}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-600">{blueprint.strategyIdea}</p>
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-slate-400">因子输入</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {blueprint.factorInputs.map((item) => (
                      <span key={`${blueprint.id}-input-${item}`} className="rounded bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="mt-3 grid gap-2">
                  <div>
                    <p className="text-[11px] font-semibold text-slate-400">验证路径</p>
                    <div className="mt-1 space-y-1 text-xs leading-5 text-slate-600">
                      {blueprint.validationPath.map((item) => <p key={`${blueprint.id}-validation-${item}`}>{item}</p>)}
                    </div>
                  </div>
                  <div className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] font-semibold text-amber-700">风控约束</p>
                    <div className="mt-1 space-y-1 text-xs leading-5 text-amber-900">
                      {blueprint.riskControls.map((item) => <p key={`${blueprint.id}-risk-${item}`}>{item}</p>)}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">因子筛选</h3>
            <p className="mt-1 text-sm text-slate-500">
              先按因子家族定位研究方向，再按落地质量查看当前能否直接参与选股和回测。
            </p>
          </div>
          <Badge variant="outline" className="bg-white text-slate-500">
            {filteredEntries.length} / {allFactors.length} 个
          </Badge>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <div>
            <p className="text-xs font-semibold text-slate-400">因子家族</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                  categoryFilter === "all"
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                )}
              >
                全部
                <span className="ml-1.5 text-xs tabular-nums text-slate-400">{allFactors.length}</span>
              </button>
              {data.factorCatalog.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setCategoryFilter(category.id)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    categoryFilter === category.id
                      ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  )}
                >
                  {category.name}
                  <span className="ml-1.5 text-xs tabular-nums text-slate-400">{category.factors.length}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-400">落地质量</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {FACTOR_STATUS_FILTERS.map((item) => {
                const count = item.id === "all"
                  ? allFactors.length
                  : allFactors.filter((factor) => factor.status === item.id).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setStatusFilter(item.id)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                      statusFilter === item.id
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    )}
                  >
                    {item.label}
                    <span className={cn(
                      "ml-1.5 text-xs tabular-nums",
                      statusFilter === item.id ? "text-white/70" : "text-slate-400"
                    )}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-sm text-slate-500">
              显示 <span className="font-semibold tabular-nums text-slate-900">{filteredEntries.length ? pageStart + 1 : 0}</span>
              {" - "}
              <span className="font-semibold tabular-nums text-slate-900">{pageEnd}</span>
              {" / "}
              <span className="font-semibold tabular-nums text-slate-900">{filteredEntries.length}</span>
              {" 个因子，每页 "}
              <span className="font-semibold tabular-nums text-slate-900">{FACTOR_PAGE_SIZE}</span>
              {" 个"}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.max(1, page - 1))}
                disabled={safePage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </Button>
              <span className="min-w-20 text-center text-sm tabular-nums text-slate-500">
                {safePage} / {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.min(totalPages, page + 1))}
                disabled={safePage >= totalPages}
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {pagedCategoryGroups.map(({ category, factors, total }) => (
            <section key={category.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-950">{category.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">{category.description}</p>
                </div>
                <Badge variant="outline" className="bg-white text-slate-500">{factors.length} / {total} 个</Badge>
              </div>
              <div className="divide-y divide-slate-100">
                {factors.map((factor) => (
                  <article key={factor.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-bold text-slate-950">{factor.name}</h4>
                          <Badge variant="outline" className={factorCatalogStatusClass(factor.status)}>
                            {factorCatalogStatusLabel(factor.status)}
                          </Badge>
                          <Badge variant="outline" className="bg-slate-50 text-slate-500">
                            {factorDirectionLabel(factor.direction)}
                          </Badge>
                          <Badge variant="outline" className="bg-white text-slate-500">
                            优先级 {factor.priority}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{factor.rationale}</p>
                      </div>
                      <p className="rounded-md bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500">
                        {factor.horizon}
                      </p>
                    </div>

                    <code className="mt-4 block rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-5 text-slate-700">
                      {factor.formula}
                    </code>

                    <div className="mt-4 grid gap-3 lg:grid-cols-4">
                      <div className="rounded-md bg-emerald-50 p-3">
                        <p className="text-xs font-semibold text-emerald-700">当前可用数据</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-emerald-900">
                          {factor.currentData.length
                            ? factor.currentData.map((item) => <p key={`${factor.id}-current-${item}`}>{item}</p>)
                            : <p>暂无</p>}
                        </div>
                      </div>
                      <div className="rounded-md bg-amber-50 p-3">
                        <p className="text-xs font-semibold text-amber-700">缺口</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-amber-900">
                          {factor.missingData.length
                            ? factor.missingData.map((item) => <p key={`${factor.id}-missing-${item}`}>{item}</p>)
                            : <p>无关键缺口</p>}
                        </div>
                      </div>
                      <div className="rounded-md bg-blue-50 p-3">
                        <p className="text-xs font-semibold text-blue-700">适用场景</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-blue-950">
                          {factor.useCases.map((item) => <p key={`${factor.id}-use-${item}`}>{item}</p>)}
                        </div>
                      </div>
                      <div className="rounded-md bg-slate-50 p-3">
                        <p className="text-xs font-semibold text-slate-500">护栏</p>
                        <div className="mt-2 space-y-1 text-xs leading-5 text-slate-700">
                          {factor.guardrails.map((item) => <p key={`${factor.id}-guard-${item}`}>{item}</p>)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="text-xs font-semibold text-slate-500">落地动作</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {factor.enrichmentPlan.map((item) => (
                          <span key={`${factor.id}-plan-${item}`} className="rounded-md bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {!filteredEntries.length && (
            <EmptyState title="没有匹配的因子" description="调整因子家族或落地质量筛选条件" className="border-0" />
          )}

          {filteredEntries.length > FACTOR_PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.max(1, page - 1))}
                disabled={safePage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </Button>
              <span className="min-w-20 text-center text-sm tabular-nums text-slate-500">
                {safePage} / {totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFactorPage((page) => Math.min(totalPages, page + 1))}
                disabled={safePage >= totalPages}
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-950">优先落地因子</p>
            <div className="mt-3 space-y-2">
              {topPriorityFactors.map((factor) => (
                <div key={`priority-${factor.id}`} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{factor.name}</p>
                    <Badge variant="outline" className={factorCatalogStatusClass(factor.status)}>
                      {factorCatalogStatusLabel(factor.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{factor.category} · {factor.horizon}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold text-slate-950">数据补充路线</p>
            <div className="mt-3 space-y-3">
              {data.factorCatalog.enrichmentPlan.map((item) => (
                <div key={item.id} className="rounded-md border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{item.currentGap}</p>
                    </div>
                    <Badge variant="outline" className={
                      item.priority === "P0"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : item.priority === "P1"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                    }>
                      {item.priority}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">目标表</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {item.targetTables.map((table) => (
                          <code key={`${item.id}-table-${table}`} className="rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                            {table}
                          </code>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">可选来源</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {item.providerOptions.map((provider) => (
                          <span key={`${item.id}-provider-${provider}`} className="rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
                            {provider}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-slate-400">解锁能力</p>
                      <div className="mt-1 space-y-1 text-xs leading-5 text-slate-600">
                        {item.unlocks.map((unlock) => <p key={`${item.id}-unlock-${unlock}`}>{unlock}</p>)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-amber-100 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">使用边界</p>
            <p className="mt-2 text-sm leading-6 text-amber-800">
              因子用于排序、过滤和回测假设，不直接等价于投资建议。缺数据的因子必须保持 needs_data 状态，不能用空值或 0 填充通过验证。
            </p>
          </section>
        </aside>
      </section>
    </div>
  );
}
