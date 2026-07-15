"use client";

import type { CLIOption } from "./tabs/AIAgentsTab";

interface InstallGuideModalProps {
  cli: CLIOption;
  onClose: () => void;
  onRefreshStatus: () => void;
  onCopyToast: (message: string, type: "success" | "error") => void;
}

function InstallGuideModal({ onClose, onRefreshStatus, onCopyToast }: InstallGuideModalProps) {
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value);
    onCopyToast("命令已复制", "success");
  };

  const steps = [
    { title: "安装项目依赖", command: "npm install" },
    { title: "配置 DeepSeek 官方 API Key", command: "DEEPSEEK_API_KEY=your_deepseek_api_key" },
    { title: "重新启动 QuantPilot", command: "npm run dev" },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 font-black text-white">M</span>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">MoAgent 修复指引</h3>
                <p className="mt-1 text-sm text-slate-600">只使用官方 API，不支持自定义中转地址。</p>
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-white/70 hover:text-slate-900" aria-label="关闭">×</button>
          </div>
        </div>

        <div className="space-y-4 p-6">
          {steps.map((step, index) => (
            <div key={step.title} className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs text-white">{index + 1}</span>
                {step.title}
              </div>
              <div className="ml-8 flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
                <code className="min-w-0 flex-1 break-all text-xs text-slate-800">{step.command}</code>
                <button type="button" onClick={() => copy(step.command)} className="text-xs font-semibold text-blue-700 hover:text-blue-800">复制</button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between border-t border-slate-200 p-5">
          <button onClick={onRefreshStatus} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-950">刷新状态</button>
          <button onClick={onClose} className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">完成</button>
        </div>
      </div>
    </div>
  );
}

export { InstallGuideModal };
export type { InstallGuideModalProps };
