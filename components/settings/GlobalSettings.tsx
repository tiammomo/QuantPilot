"use client";
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { AnimatePresence } from 'framer-motion';
import { MotionDiv } from '@/lib/motion';
import ServiceConnectionModal from '@/components/modals/ServiceConnectionModal';
import { FaCog } from 'react-icons/fa';
import { useGlobalSettings } from '@/contexts/GlobalSettingsContext';
import { getModelDefinitionsForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { fetchCliStatusSnapshot, createCliStatusFallback } from '@/hooks/useCLI';
import type { CLIStatus } from '@/types/cli';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type SettingsTab = 'general' | 'ai-agents' | 'services' | 'about';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
}

interface CLIOption {
  id: string;
  name: string;
  icon: string;
  description: string;
  models: { id: string; name: string; description?: string; provider?: string; runtime?: string; external?: boolean; }[];
  color: string;
  brandColor: string;
  downloadUrl: string;
  installCommand: string;
  enabled?: boolean;
}

const CLI_OPTIONS: CLIOption[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    icon: '',
    description: 'Claude Code runtime with Anthropic-compatible model providers',
    color: 'from-orange-500 to-red-600',
    brandColor: '#DE7356',
    downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    enabled: true,
    models: getModelDefinitionsForCli('claude').map(({ id, name, description, provider, external }) => ({
      id,
      name,
      description,
      provider,
      external,
    })),
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    icon: '',
    description: 'OpenAI Codex agent with GPT-5 support',
    color: 'from-slate-900 to-gray-700',
    brandColor: '#000000',
    downloadUrl: 'https://github.com/openai/codex',
    installCommand: 'npm install -g @openai/codex',
    enabled: true,
    models: getModelDefinitionsForCli('codex').map(({ id, name, description, provider, runtime, external }) => ({
      id,
      name,
      description,
      provider,
      runtime,
      external,
    })),
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    icon: '',
    description: 'Cursor CLI with multi-model router and autonomous tooling',
    color: 'from-slate-500 to-gray-600',
    brandColor: '#6B7280',
    downloadUrl: 'https://docs.cursor.com/en/cli/overview',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    enabled: true,
    models: getModelDefinitionsForCli('cursor').map(({ id, name, description }) => ({ id, name, description })),
  },
  {
    id: 'qwen',
    name: 'Qwen Coder',
    icon: '',
    description: 'Alibaba Qwen Code CLI with sandbox capabilities',
    color: 'from-emerald-500 to-teal-600',
    brandColor: '#11A97D',
    downloadUrl: 'https://github.com/QwenLM/qwen-code',
    installCommand: 'npm install -g @qwen-code/qwen-code',
    enabled: true,
    models: getModelDefinitionsForCli('qwen').map(({ id, name, description }) => ({ id, name, description })),
  },
  {
    id: 'glm',
    name: 'GLM CLI',
    icon: '',
    description: 'Zhipu GLM agent running on Claude Code runtime',
    color: 'from-blue-500 to-indigo-600',
    brandColor: '#1677FF',
    downloadUrl: 'https://docs.z.ai/devpack/tool/claude',
    installCommand: 'zai devpack install claude',
    enabled: true,
    models: getModelDefinitionsForCli('glm').map(({ id, name, description }) => ({ id, name, description })),
  },
];

const SERVICE_LABELS: Record<string, string> = {
  github: 'GitHub',
  supabase: 'Supabase',
  vercel: 'Vercel',
};

const GENERATION_POLICIES = [
  {
    title: '生成工作空间',
    description: '首页任务会使用默认智能体与模型创建工作空间，并继承已配置的服务令牌。',
    status: '自动继承',
  },
  {
    title: '评测链路',
    description: '测试用例、评测集和运行记录使用同一套模型与服务连接，便于复盘生成质量。',
    status: '统一配置',
  },
  {
    title: '失败修复',
    description: '运维平台负责健康检查、生成链路观测和失败修复，这里只维护全局默认项。',
    status: '运维台处理',
  },
];

// Global settings are provided by context

interface ServiceToken {
  id: string;
  provider: string;
  token: string;
  name?: string;
  created_at: string;
  last_used?: string;
}

export default function GlobalSettings({ isOpen, onClose, initialTab = 'general' }: GlobalSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [serviceModalOpen, setServiceModalOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<'github' | 'supabase' | 'vercel' | null>(null);
  const [tokens, setTokens] = useState<{ [key: string]: ServiceToken | null }>({
    github: null,
    supabase: null,
    vercel: null
  });
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const { settings: globalSettings, setSettings: setGlobalSettings, refresh: refreshGlobalSettings } = useGlobalSettings();
  const [isLoading, setIsLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [selectedCLI, setSelectedCLI] = useState<CLIOption | null>(null);
  const [apiKeyVisibility, setApiKeyVisibility] = useState<Record<string, boolean>>({});

  // Show toast function
  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAllTokens = useCallback(async () => {
    const providers = ['github', 'supabase', 'vercel'];
    const newTokens: { [key: string]: ServiceToken | null } = {};
    
    for (const provider of providers) {
      try {
        const response = await fetch(`${API_BASE}/api/tokens/${provider}`);
        if (response.ok) {
          newTokens[provider] = await response.json();
        } else {
          newTokens[provider] = null;
        }
      } catch {
        newTokens[provider] = null;
      }
    }
    
    setTokens(newTokens);
  }, []);

  const handleServiceClick = (provider: 'github' | 'supabase' | 'vercel') => {
    setSelectedProvider(provider);
    setServiceModalOpen(true);
  };

  const handleServiceModalClose = () => {
    setServiceModalOpen(false);
    setSelectedProvider(null);
    loadAllTokens(); // Reload tokens after modal closes
  };

  const loadGlobalSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/settings/global`);
      if (response.ok) {
        const settings = await response.json();
        if (settings?.cli_settings) {
          for (const [cli, config] of Object.entries(settings.cli_settings)) {
            if (config && typeof config === 'object' && 'model' in config) {
              (config as any).model = normalizeModelId(cli, (config as any).model as string);
            }
          }
        }
        setGlobalSettings(settings);
      }
    } catch (error) {
      console.error('Failed to load global settings:', error);
    }
  }, [setGlobalSettings]);

  const checkCLIStatus = useCallback(async () => {
    const checkingStatus: CLIStatus = CLI_OPTIONS.reduce((acc, cli) => {
      acc[cli.id] = { installed: true, checking: true };
      return acc;
    }, {} as CLIStatus);
    setCLIStatus(checkingStatus);

    try {
      const status = await fetchCliStatusSnapshot();
      setCLIStatus(status);
    } catch (error) {
      console.error('Error checking CLI status:', error);
      setCLIStatus(createCliStatusFallback());
    }
  }, []);

  // Load all service tokens and CLI data
  useEffect(() => {
    if (isOpen) {
      loadAllTokens();
      loadGlobalSettings();
      checkCLIStatus();
    }
  }, [isOpen, loadAllTokens, loadGlobalSettings, checkCLIStatus]);

  const saveGlobalSettings = async () => {
    setIsLoading(true);
    setSaveMessage(null);
    
    try {
      const payload = JSON.parse(JSON.stringify(globalSettings));
      if (payload?.cli_settings) {
        for (const [cli, config] of Object.entries(payload.cli_settings)) {
          if (config && typeof config === 'object' && 'model' in config) {
            (config as any).model = normalizeModelId(cli, (config as any).model as string);
          }
        }
      }

      const response = await fetch(`${API_BASE}/api/settings/global`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error('Failed to save settings');
      }
      
      setSaveMessage({ 
        type: 'success', 
        text: '设置已保存' 
      });
      // make sure context stays in sync
      try {
        await refreshGlobalSettings();
      } catch {}
      
      // Clear message after 3 seconds
      setTimeout(() => setSaveMessage(null), 3000);
      
    } catch (error) {
      console.error('Failed to save global settings:', error);
      setSaveMessage({ 
        type: 'error', 
        text: '设置保存失败，请稍后重试' 
      });
      
      // Clear error message after 5 seconds
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setIsLoading(false);
    }
  };


  const setDefaultCLI = (cliId: string) => {
    const cliInstalled = cliStatus[cliId]?.installed;
    if (!cliInstalled) return;
    
    setGlobalSettings(prev => ({
      ...prev,
      default_cli: cliId
    }));
  };

  const setDefaultModel = (cliId: string, modelId: string) => {
    setGlobalSettings(prev => ({
      ...prev,
      cli_settings: {
        ...(prev?.cli_settings ?? {}),
        [cliId]: {
          ...(prev?.cli_settings?.[cliId] ?? {}),
          model: normalizeModelId(cliId, modelId)
        }
      }
    }));
  };

  const setCliApiKey = (cliId: string, apiKey: string) => {
    setGlobalSettings(prev => {
      const nextCliSettings = { ...(prev?.cli_settings ?? {}) };
      const existing = { ...(nextCliSettings[cliId] ?? {}) };
      const trimmed = apiKey.trim();

      if (trimmed.length > 0) {
        existing.apiKey = trimmed;
        nextCliSettings[cliId] = existing;
      } else {
        delete existing.apiKey;
        if (Object.keys(existing).length > 0) {
          nextCliSettings[cliId] = existing;
        } else {
          delete nextCliSettings[cliId];
        }
      }

      return {
        ...prev,
        cli_settings: nextCliSettings,
      };
    });
  };

  const toggleApiKeyVisibility = (cliId: string) => {
    setApiKeyVisibility(prev => ({
      ...prev,
      [cliId]: !prev[cliId],
    }));
  };

  const defaultCli = CLI_OPTIONS.find(cli => cli.id === globalSettings.default_cli);
  const defaultCliSettings = defaultCli ? globalSettings.cli_settings?.[defaultCli.id] || {} : {};
  const defaultModel = defaultCli?.models.find(model => model.id === defaultCliSettings.model);
  const installedAgentCount = CLI_OPTIONS.filter(cli => cli.enabled !== false && cliStatus[cli.id]?.installed).length;
  const configuredServiceCount = Object.values(tokens).filter(Boolean).length;

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case 'github':
        return (
          <svg width="20" height="20" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
          </svg>
        );
      case 'supabase':
        return (
          <svg width="20" height="20" viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#paint0_linear)"/>
            <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E"/>
            <defs>
              <linearGradient id="paint0_linear" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                <stop stopColor="#249361"/>
                <stop offset="1" stopColor="#3ECF8E"/>
              </linearGradient>
            </defs>
          </svg>
        );
      case 'vercel':
        return (
          <svg width="20" height="20" viewBox="0 0 76 65" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" fill="currentColor"/>
          </svg>
        );
      default:
        return null;
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div key="global-settings-shell" className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div 
          className="absolute inset-0 bg-black/60 backdrop-blur-md"
          onClick={onClose}
        />
        
        <MotionDiv 
          className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[700px] border border-gray-200 flex flex-col"
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
        >
          {/* Header */}
          <div className="p-5 border-b border-gray-200 ">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-gray-600 ">
                  <FaCog size={20} />
                </span>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900 ">平台设置</h2>
                  <p className="text-sm text-gray-600 ">管理生成工作空间使用的智能体、模型与服务令牌</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="text-gray-600 hover:text-gray-900 transition-colors p-1 hover:bg-gray-100 rounded-lg"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="border-b border-gray-200 ">
            <nav className="flex px-5">
              {[
                { id: 'general' as const, label: '生成与模型' },
                { id: 'ai-agents' as const, label: '智能体' },
                { id: 'services' as const, label: '服务令牌' },
                { id: 'about' as const, label: '关于' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${
                    activeTab === tab.id
                      ? 'border-[#DE7356] text-gray-900 '
                      : 'border-transparent text-gray-600 hover:text-gray-700 hover:border-gray-300 '
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="flex-1 p-6 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
            {activeTab === 'general' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs font-medium text-gray-500">默认智能体</p>
                    <p className="mt-2 text-lg font-semibold text-gray-900">{defaultCli?.name ?? '未配置'}</p>
                    <p className="mt-1 text-sm text-gray-600">
                      {cliStatus[globalSettings.default_cli]?.installed ? '已安装，可用于新任务' : '未检测到安装状态'}
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs font-medium text-gray-500">默认模型</p>
                    <p className="mt-2 text-lg font-semibold text-gray-900">{defaultModel?.name ?? '未选择模型'}</p>
                    <p className="mt-1 text-sm text-gray-600">首页创建任务时默认采用该模型</p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-xs font-medium text-gray-500">服务令牌</p>
                    <p className="mt-2 text-lg font-semibold text-gray-900">{configuredServiceCount}/3 已配置</p>
                    <p className="mt-1 text-sm text-gray-600">GitHub、Supabase、Vercel 连接状态</p>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">生成链路默认配置</h3>
                      <p className="mt-1 text-sm text-gray-600">
                        这里的配置会影响首页生成、项目会话和评测运行；具体工作空间健康与修复在运维平台处理。
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveTab('ai-agents')}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        配置智能体
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab('services')}
                        className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                      >
                        配置服务令牌
                      </button>
                    </div>
                  </div>

                  <div className="mt-5 space-y-3">
                    {GENERATION_POLICIES.map(policy => (
                      <div key={policy.title} className="flex items-start justify-between gap-4 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                        <div>
                          <p className="font-medium text-gray-900">{policy.title}</p>
                          <p className="mt-1 text-sm leading-6 text-gray-600">{policy.description}</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-gray-600 ring-1 ring-gray-200">
                          {policy.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">当前可用智能体</span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-gray-600 ring-1 ring-gray-200">
                      {installedAgentCount}/{CLI_OPTIONS.filter(cli => cli.enabled !== false).length}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-gray-600">
                    未安装的智能体不会作为默认选项。新建工作空间时，如果需要切换运行时，可以在首页输入框下方临时选择。
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'ai-agents' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-1">智能体运行时</h3>
                      <p className="text-sm text-gray-600 ">
                        管理生成工作空间和评测任务可使用的 CLI 智能体
                      </p>
                    </div>
                    {/* Inline Default CLI Selector */}
                    <div className="flex items-center gap-2 ml-6 pl-6 border-l border-gray-200 ">
                      <span className="text-sm text-gray-600 ">默认:</span>
                      <select
                        value={globalSettings.default_cli}
                        onChange={(e) => setDefaultCLI(e.target.value)}
                        className="pl-3 pr-8 py-1.5 text-xs font-medium border border-gray-200/50 rounded-full bg-transparent hover:bg-gray-50 hover:border-gray-300/50 text-gray-700 focus:outline-none focus:ring-0 transition-colors cursor-pointer"
                      >
                        {CLI_OPTIONS.filter(cli => cliStatus[cli.id]?.installed && cli.enabled !== false).map(cli => (
                          <option key={cli.id} value={cli.id}>
                            {cli.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {saveMessage && (
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm ${
                        saveMessage.type === 'success' 
                          ? 'bg-green-100 text-green-700 '
                          : 'bg-red-100 text-red-700 '
                      }`}>
                        {saveMessage.type === 'success' ? (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                        {saveMessage.text}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={checkCLIStatus}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-200/50 rounded-full bg-transparent hover:bg-gray-50 hover:border-gray-300/50 text-gray-700 transition-colors"
                      >
                        刷新状态
                      </button>
                      <button
                        onClick={saveGlobalSettings}
                        disabled={isLoading}
                        className="px-3 py-1.5 text-xs font-medium bg-gray-900 hover:bg-gray-800 text-white rounded-full transition-colors disabled:opacity-50"
                      >
                        {isLoading ? '保存中...' : '保存设置'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* CLI Agents Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {CLI_OPTIONS.filter(cli => cli.enabled !== false).map((cli) => {
                    const status = cliStatus[cli.id];
                    const settings = globalSettings.cli_settings[cli.id] || {};
                    const isChecking = status?.checking || false;
                    const isInstalled = status?.installed || false;
                    const isDefault = globalSettings.default_cli === cli.id;

                    return (
                      <div 
                        key={cli.id} 
                        onClick={() => isInstalled && setDefaultCLI(cli.id)}
                        className={`border rounded-xl pl-4 pr-8 py-4 transition-all ${
                          !isInstalled 
                            ? 'border-gray-200/50 cursor-not-allowed bg-gray-50/50 ' 
                            : isDefault 
                              ? 'cursor-pointer' 
                              : 'border-gray-200/50 hover:border-gray-300/50 hover:bg-gray-50 cursor-pointer'
                        }`}
                        style={isDefault && isInstalled ? {
                          borderColor: cli.brandColor,
                          backgroundColor: `${cli.brandColor}08`
                        } : {}}
                      >
                        <div className="flex items-start gap-3 mb-3">
                          <div className={`flex-shrink-0 ${!isInstalled ? 'opacity-40' : ''}`}>
                            {cli.id === 'claude' && (
                              <Image src="/claude.png" alt="Claude" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'cursor' && (
                              <Image src="/cursor.png" alt="Cursor" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'codex' && (
                              <Image src="/oai.png" alt="Codex" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'qwen' && (
                              <Image src="/qwen.png" alt="Qwen" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'glm' && (
                              <Image src="/glm.svg" alt="GLM" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'gemini' && (
                              <Image src="/gemini.png" alt="Gemini" width={32} height={32} className="w-8 h-8" />
                            )}
                          </div>
                          <div className={`flex-1 min-w-0 ${!isInstalled ? 'opacity-40' : ''}`}>
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-gray-900 text-sm">{cli.name}</h4>
                              {isDefault && isInstalled && (
                                <span className="text-xs font-medium" style={{ color: cli.brandColor }}>
                                  默认
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                              {cli.description}
                            </p>
                          </div>
                        </div>

                        {/* Model Selection or Not Installed */}
                        {isInstalled ? (
                          <div onClick={(e) => e.stopPropagation()} className="space-y-3">
                            <select
                              value={settings.model || ''}
                              onChange={(e) => setDefaultModel(cli.id, e.target.value)}
                              className="w-full px-3 py-1.5 border border-gray-200/50 rounded-full bg-transparent hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors focus:outline-none focus:ring-0"
                            >
                              <option value="">选择模型</option>
                              {cli.models.filter(model => model.id.trim().length > 0).map(model => (
                                <option key={`${cli.id}-${model.id}`} value={model.id}>
                                  {model.external ? `${model.name} · 外部` : model.name}
                                </option>
                              ))}
                            </select>

                            {settings.model && cli.models.find(model => model.id === settings.model)?.description && (
                              <p className="text-[11px] text-gray-500 leading-snug">
                                {cli.models.find(model => model.id === settings.model)?.description}
                              </p>
                            )}

                            {cli.id === 'glm' && (
                              <div className="space-y-1.5">
                                <label className="text-xs font-medium text-gray-600 ">
                                  API Key
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type={apiKeyVisibility[cli.id] ? 'text' : 'password'}
                                    value={settings.apiKey ?? ''}
                                    onChange={(e) => setCliApiKey(cli.id, e.target.value)}
                                    placeholder="输入 GLM API Key"
                                    className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-200"
                                  />
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      toggleApiKeyVisibility(cli.id);
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg bg-white transition-colors"
                                  >
                                    {apiKeyVisibility[cli.id] ? '隐藏' : '显示'}
                                  </button>
                                </div>
                                <p className="text-[11px] text-gray-500 leading-snug">
                                  保存在本地设置中，运行 GLM 时注入为 <code className="font-mono">ZHIPU_API_KEY</code> 及兼容别名。
                                  留空则使用服务端环境变量。
                                </p>
                              </div>
                            )}
                            {cli.id === 'cursor' && (
                              <div className="space-y-1.5">
                                <label className="text-xs font-medium text-gray-600 ">
                                  API Key（可选）
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type={apiKeyVisibility[cli.id] ? 'text' : 'password'}
                                    value={settings.apiKey ?? ''}
                                    onChange={(e) => setCliApiKey(cli.id, e.target.value)}
                                    placeholder="输入 Cursor API Key"
                                    className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-200"
                                  />
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      toggleApiKeyVisibility(cli.id);
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg bg-white transition-colors"
                                  >
                                    {apiKeyVisibility[cli.id] ? '隐藏' : '显示'}
                                  </button>
                                </div>
                                <p className="text-[11px] text-gray-500 leading-snug">
                                  注入为 <code className="font-mono">CURSOR_API_KEY</code> 并传递给 <code className="font-mono">cursor-agent</code>。
                                  留空则使用已登录的 Cursor CLI 会话。
                                </p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => {
                                setSelectedCLI(cli);
                                setInstallModalOpen(true);
                              }}
                              className="w-full px-3 py-1.5 border-2 border-gray-900 rounded-full bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold transition-all transform hover:scale-105"
                            >
                              查看安装指引
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                </div>
              </div>
            )}

            {activeTab === 'services' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 mb-4">服务令牌</h3>
                  <p className="text-sm text-gray-600 mb-6">
                    配置 GitHub、Supabase 与 Vercel 令牌。令牌会被所有工作空间复用，用于仓库创建、数据库接入和部署发布。
                  </p>
                  
                  <div className="space-y-4">
                    {Object.entries(tokens).map(([provider, token]) => (
                      <div key={provider} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200 ">
                        <div className="flex items-center gap-3">
                          <div className="text-gray-700 ">
                            {getProviderIcon(provider)}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{SERVICE_LABELS[provider] ?? provider}</p>
                            <p className="text-sm text-gray-600 ">
                              {token ? (
                                <>
                                  已配置令牌 · {new Date(token.created_at).toLocaleDateString()}
                                </>
                              ) : (
                                '未配置令牌'
                              )}
                            </p>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          {token && (
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                          )}
                          <button
                            onClick={() => handleServiceClick(provider as 'github' | 'supabase' | 'vercel')}
                            className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-all"
                          >
                            {token ? '更新令牌' : '添加令牌'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200 ">
                    <div className="flex">
                      <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-[#DE7356]" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                        </svg>
                      </div>
                      <div className="ml-3">
                        <h3 className="text-sm font-medium text-gray-900 ">
                          令牌使用范围
                        </h3>
                        <div className="mt-2 text-sm text-gray-700 ">
                          <p>
                            这里保存的是平台级凭据。具体项目绑定到哪个 GitHub 仓库、Supabase 项目或 Vercel 项目，
                            仍在对应工作空间的项目设置中完成。
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="space-y-6">
                <div className="text-center">
                  <div className="w-20 h-20 mx-auto mb-4 relative">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#DE7356]/20 to-[#DE7356]/5 blur-xl rounded-2xl" />
                    <Image
                      src="/QuantPilot_Icon.png"
                      alt="QuantPilot Icon"
                      width={80}
                      height={80}
                      className="relative z-10 w-full h-full object-contain rounded-2xl shadow-lg"
                    />
                  </div>
                  <h3 className="text-2xl font-bold text-gray-900 ">QuantPilot</h3>
                  <p className="text-gray-600 mt-2 font-medium">Version 1.0.0</p>
                </div>
                
                <div className="bg-gray-50 rounded-xl border border-gray-200 p-6 space-y-4">
                  <div className="text-center">
                    <p className="text-base text-gray-700 leading-relaxed max-w-2xl mx-auto">
                      QuantPilot 是面向量化研发的 AI 工作台，支持通过 Claude Code 兼容运行时接入外部模型，
                      并串联 GitHub、Supabase 与 Vercel 等工程化服务。
                    </p>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div className="p-3 rounded-xl border border-gray-200/50 bg-transparent">
                      <div className="flex items-center justify-center mb-2">
                        <svg className="w-5 h-5 text-[#DE7356]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                      <p className="text-xs font-medium text-gray-700 ">快速部署</p>
                    </div>
                    <div className="p-3 rounded-xl border border-gray-200/50 bg-transparent">
                      <div className="flex items-center justify-center mb-2">
                        <svg className="w-5 h-5 text-[#DE7356]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                      </div>
                      <p className="text-xs font-medium text-gray-700 ">AI 驱动</p>
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <div className="flex justify-center gap-6">
                    <a 
                      href="https://github.com/tiammomo/QuantPilot" 
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[#DE7356] hover:text-[#c95940] transition-colors"
                    >
                      GitHub
                    </a>
                    <a 
                      href="https://discord.gg/NJNbafHNQC" 
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[#DE7356] hover:text-[#c95940] transition-colors"
                    >
                      Discord
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </MotionDiv>
      </div>
      
      {/* Service Connection Modal */}
      {selectedProvider && (
        <ServiceConnectionModal
          key={`service-token-${selectedProvider}`}
          isOpen={serviceModalOpen}
          onClose={handleServiceModalClose}
          provider={selectedProvider}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <div key="global-settings-toast" className={`fixed bottom-4 right-4 z-[80] px-4 py-3 rounded-lg shadow-2xl transition-all transform animate-slide-in-up ${
          toast.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
        }`}>
          <div className="flex items-center gap-2">
            {toast.type === 'success' && (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            <span className="font-medium">{toast.message}</span>
          </div>
        </div>
      )}

      {/* Install Guide Modal */}
      {installModalOpen && selectedCLI && (
        <div key={`install-guide-${selectedCLI.id}`} className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
            onClick={() => {
              setInstallModalOpen(false);
              setSelectedCLI(null);
            }}
          />
          
          <div 
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-200 transform"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 border-b border-gray-200 ">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {selectedCLI.id === 'claude' && (
                    <Image src="/claude.png" alt="Claude" width={32} height={32} className="w-8 h-8" />
                  )}
                  {selectedCLI.id === 'cursor' && (
                    <Image src="/cursor.png" alt="Cursor" width={32} height={32} className="w-8 h-8" />
                  )}
                  {selectedCLI.id === 'codex' && (
                    <Image src="/oai.png" alt="Codex" width={32} height={32} className="w-8 h-8" />
                  )}
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 ">
                      安装 {selectedCLI.name}
                    </h3>
                    <p className="text-sm text-gray-600 ">
                      完成安装和登录后，回到这里刷新状态即可使用
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setInstallModalOpen(false);
                    setSelectedCLI(null);
                  }}
                  className="text-gray-600 hover:text-gray-900 transition-colors p-1 hover:bg-gray-100 rounded-lg"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              {/* Step 1: Install */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    1
                  </span>
                  安装 CLI
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 flex-1">
                    {selectedCLI.installCommand}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigator.clipboard.writeText(selectedCLI.installCommand);
                      showToast('命令已复制', 'success');
                    }}
                    className="text-gray-500 hover:text-gray-700 "
                    title="复制命令"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Step 2: Authenticate */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    2
                  </span>
                  {selectedCLI.id === 'gemini' && '登录 Gemini（OAuth 或 API Key）'}
                  {selectedCLI.id === 'glm' && '登录 Z.ai DevPack'}
                  {selectedCLI.id === 'qwen' && '登录 Qwen（OAuth 或 API Key）'}
                  {selectedCLI.id === 'codex' && '启动 Codex 并登录'}
                  {selectedCLI.id === 'claude' && '启动 Claude 并登录'}
                  {selectedCLI.id === 'cursor' && '启动 Cursor CLI 并登录'}
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 flex-1">
                    {selectedCLI.id === 'claude' ? 'claude' :
                     selectedCLI.id === 'cursor' ? 'cursor-agent' :
                     selectedCLI.id === 'codex' ? 'codex' :
                     selectedCLI.id === 'qwen' ? 'qwen' :
                     selectedCLI.id === 'glm' ? 'zai' :
                     selectedCLI.id === 'gemini' ? 'gemini' : ''}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const authCmd = selectedCLI.id === 'claude' ? 'claude' :
                                      selectedCLI.id === 'cursor' ? 'cursor-agent' :
                                      selectedCLI.id === 'codex' ? 'codex' :
                                      selectedCLI.id === 'qwen' ? 'qwen' :
                                      selectedCLI.id === 'glm' ? 'zai' :
                                      selectedCLI.id === 'gemini' ? 'gemini' : '';
                      if (authCmd) navigator.clipboard.writeText(authCmd);
                      showToast('命令已复制', 'success');
                    }}
                    className="text-gray-500 hover:text-gray-700 "
                    title="复制命令"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Step 3: Test */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    3
                  </span>
                  检查安装状态
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 flex-1">
                    {selectedCLI.id === 'claude' ? 'claude --version' :
                     selectedCLI.id === 'cursor' ? 'cursor-agent --version' :
                     selectedCLI.id === 'codex' ? 'codex --version' :
                     selectedCLI.id === 'qwen' ? 'qwen --version' :
                     selectedCLI.id === 'glm' ? 'zai --version' :
                     selectedCLI.id === 'gemini' ? 'gemini --version' : ''}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const versionCmd = selectedCLI.id === 'claude' ? 'claude --version' :
                                        selectedCLI.id === 'cursor' ? 'cursor-agent --version' :
                                        selectedCLI.id === 'codex' ? 'codex --version' :
                                        selectedCLI.id === 'qwen' ? 'qwen --version' :
                                        selectedCLI.id === 'glm' ? 'zai --version' :
                                        selectedCLI.id === 'gemini' ? 'gemini --version' : '';
                      if (versionCmd) navigator.clipboard.writeText(versionCmd);
                      showToast('命令已复制', 'success');
                    }}
                    className="text-gray-500 hover:text-gray-700 "
                    title="复制命令"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Minimal guide only; removed extra info */}
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-gray-200 flex justify-between">
              <button
                onClick={() => checkCLIStatus()}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                刷新状态
              </button>
              <button
                onClick={() => {
                  setInstallModalOpen(false);
                  setSelectedCLI(null);
                }}
                className="px-4 py-2 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}
