"use client";

import type { CLIStatus } from "@/types/cli";

interface CLIOption {
  id: string;
  name: string;
  icon: string;
  description: string;
  models: { id: string; name: string; description?: string; provider?: string; runtime?: string; external?: boolean }[];
  color: string;
  brandColor: string;
  downloadUrl: string;
  installCommand: string;
  enabled?: boolean;
}

interface AIAgentsTabProps {
  cliOptions: CLIOption[];
  cliStatus: CLIStatus;
  saveMessage: { type: "success" | "error"; text: string } | null;
  isLoading: boolean;
  selectedModelId?: string;
  onRefreshCliStatus: () => void;
  onSaveSettings: () => void;
  onSelectModel: (modelId: string) => void;
  onOpenInstallModal: (cli: CLIOption) => void;
}

function AIAgentsTab({
  cliOptions,
  cliStatus,
  saveMessage,
  isLoading,
  selectedModelId,
  onRefreshCliStatus,
  onSaveSettings,
  onSelectModel,
  onOpenInstallModal,
}: AIAgentsTabProps) {
  const runtime = cliOptions[0];
  const status = runtime ? cliStatus[runtime.id] : undefined;
  const installed = Boolean(status?.installed);
  const configured = Boolean(status?.configured);
  const configuredModelIds = new Set(status?.models ?? []);

  const connectionForModel = (model: CLIOption["models"][number]) =>
    model.runtime === "modelport"
      ? {
          label: "ModelPort OpenAI-compatible",
          endpoint: "127.0.0.1:38082/v1",
          credentialEnv: "MODELPORT_API_KEY",
        }
      : {
          label: "DeepSeek 官方 API",
          endpoint: "api.deepseek.com",
          credentialEnv: "DEEPSEEK_API_KEY",
        };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Multi-provider runtime</p>
          <h3 className="mt-2 text-lg font-semibold text-slate-950">MoAgent 模型接入</h3>
          <p className="mt-1 text-sm text-slate-600">本机 Qwen 为默认模型；日常 DeepSeek 经 ModelPort，官方直连仅作为可选备用。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshCliStatus}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
          >
            刷新状态
          </button>
          <button
            onClick={onSaveSettings}
            disabled={isLoading}
            className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {isLoading ? "保存中..." : "确认配置"}
          </button>
        </div>
      </div>

      {saveMessage && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${saveMessage.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {saveMessage.text}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-gradient-to-r from-blue-50 via-white to-indigo-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-xl font-black text-white">M</span>
              <div>
                <h4 className="font-semibold text-slate-950">{runtime?.name ?? "MoAgent"}</h4>
                <p className="mt-1 text-xs text-slate-600">{runtime?.description}</p>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${configured && installed ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
              {configured && installed ? "已就绪" : "待配置"}
            </span>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          {runtime?.models.map((model) => {
            const connection = connectionForModel(model);
            const modelConfigured = configuredModelIds.has(model.id);
            const selected = selectedModelId === model.id;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => onSelectModel(model.id)}
                className={`rounded-xl border p-4 text-left transition ${selected ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : "border-slate-200 bg-slate-50 hover:border-slate-300"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{model.name}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{model.description}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${modelConfigured ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                    {modelConfigured ? "凭据已配置" : "待配置"}
                  </span>
                </div>
                <code className="mt-3 block break-all text-xs text-blue-700">{model.id}</code>
                <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                  <span>{connection.label}</span>
                  <code className="break-all">{connection.endpoint}</code>
                  <code className="sm:col-span-2">{connection.credentialEnv}</code>
                </div>
                {selected && <p className="mt-3 text-xs font-semibold text-blue-700">当前全局默认模型</p>}
              </button>
            );
          })}
        </div>

        {!installed && runtime && (
          <div className="border-t border-slate-100 px-5 py-4">
            <button onClick={() => onOpenInstallModal(runtime)} className="text-sm font-semibold text-blue-700 hover:text-blue-800">
              查看本地执行引擎修复指引
            </button>
          </div>
        )}
        {!configured && (
          <div className="border-t border-amber-100 bg-amber-50 px-5 py-4 text-sm text-amber-800">
            在 <code className="rounded bg-white/70 px-1.5 py-0.5">.env.local</code> 配置 <code className="rounded bg-white/70 px-1.5 py-0.5">MODELPORT_API_KEY</code> 后重启项目；官方直连的 <code className="rounded bg-white/70 px-1.5 py-0.5">DEEPSEEK_API_KEY</code> 保持可选且默认不配置。
          </div>
        )}
      </div>
    </div>
  );
}

export { AIAgentsTab };
export type { AIAgentsTabProps, CLIOption };
