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
  onRefreshCliStatus: () => void;
  onSaveSettings: () => void;
  onOpenInstallModal: (cli: CLIOption) => void;
}

function AIAgentsTab({
  cliOptions,
  cliStatus,
  saveMessage,
  isLoading,
  onRefreshCliStatus,
  onSaveSettings,
  onOpenInstallModal,
}: AIAgentsTabProps) {
  const runtime = cliOptions[0];
  const status = runtime ? cliStatus[runtime.id] : undefined;
  const model = runtime?.models[0];
  const installed = Boolean(status?.installed);
  const configured = Boolean(status?.configured);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Official API only</p>
          <h3 className="mt-2 text-lg font-semibold text-slate-950">DeepSeek 模型接入</h3>
          <p className="mt-1 text-sm text-slate-600">平台仅保留 DeepSeek V4 Flash，且固定直连 DeepSeek 官方接口。</p>
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

        <div className="grid gap-4 p-5 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">唯一模型</p>
            <p className="mt-2 font-semibold text-slate-950">{model?.name ?? "DeepSeek V4 Flash"}</p>
            <code className="mt-2 block text-xs text-blue-700">deepseek-v4-flash</code>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">官方接口</p>
            <p className="mt-2 font-semibold text-slate-950">MoAgent · DeepSeek API</p>
            <code className="mt-2 block break-all text-xs text-blue-700">api.deepseek.com/chat/completions</code>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">API Key</p>
            <p className="mt-2 font-semibold text-slate-950">{configured ? "已从服务端环境读取" : "尚未配置"}</p>
            <code className="mt-2 block text-xs text-blue-700">DEEPSEEK_API_KEY</code>
          </div>
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
            在 <code className="rounded bg-white/70 px-1.5 py-0.5">.env.local</code> 写入 <code className="rounded bg-white/70 px-1.5 py-0.5">DEEPSEEK_API_KEY</code> 后重启项目。Base URL 与模型不可自定义。
          </div>
        )}
      </div>
    </div>
  );
}

export { AIAgentsTab };
export type { AIAgentsTabProps, CLIOption };
