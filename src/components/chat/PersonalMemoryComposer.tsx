'use client';

import { AlertTriangle, BrainCircuit, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

import {
  PERSONAL_MEMORY_PREFERENCE_OPTIONS,
  type PersonalMemoryPreferenceKey,
  type PersonalMemoryScope,
  savePersonalPreference,
} from './personal-memory-client';

interface PersonalMemoryComposerProps {
  projectId: string;
  suggestedValue?: string;
  disabled?: boolean;
}

export default function PersonalMemoryComposer({
  projectId,
  suggestedValue = '',
  disabled = false,
}: PersonalMemoryComposerProps) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<PersonalMemoryPreferenceKey>('output.answer_style');
  const [scope, setScope] = useState<PersonalMemoryScope>('project');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    const normalized = value.trim();
    if (!normalized || normalized.length > 4_096) {
      setError('请输入 1–4096 个字符的明确偏好。');
      return;
    }
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await savePersonalPreference({
        projectId,
        eventId: `memory-preference:${crypto.randomUUID()}`,
        key,
        value: normalized,
        scope,
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '偏好保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setOpen(next);
        if (next) {
          setSaved(false);
          setError('');
        }
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 items-center gap-1 rounded-full px-2 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          title="明确确认一条偏好，供后续任务召回"
          aria-label="记住一条个人偏好"
        >
          <BrainCircuit className="h-3.5 w-3.5" />
          <span>记住偏好</span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-[min(92vw,440px)] flex-col gap-0 overflow-y-auto border-border/70 p-0 sm:max-w-[440px]"
      >
        <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12">
          <SheetTitle className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5 text-primary" />
            记住一条偏好
          </SheetTitle>
          <SheetDescription className="leading-6">
            只有你点击“确认并保存”后才会写入。它用于个性化分析与输出，不会改变权限、交易规则或风控边界。
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-5">
          {error ? (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-red-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p>{error}</p>
                {error.includes('用户记忆') || error.includes('个性化') ? (
                  <Link href="/account/memory" className="mt-1 inline-block font-medium underline underline-offset-2">
                    打开用户记忆设置
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
          {saved ? (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              已保存。下一轮匹配的 QuantPilot 任务会尝试召回这条偏好。
            </div>
          ) : null}

          <label className="block space-y-2 text-sm font-medium text-foreground">
            偏好类型
            <select
              value={key}
              onChange={(event) => setKey(event.target.value as PersonalMemoryPreferenceKey)}
              disabled={saving}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            >
              {PERSONAL_MEMORY_PREFERENCE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label} · {option.key}</option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 text-sm font-medium text-foreground">
            希望 QuantPilot 记住什么
            <textarea
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
              maxLength={4_096}
              rows={6}
              placeholder="例如：回答时先给三行结论，再列证据、风险和数据时点。"
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
            />
            <span className="flex items-center justify-between text-xs font-normal text-muted-foreground">
              <span>只写明确偏好，不会自动保存整段聊天。</span>
              <span>{value.length}/4096</span>
            </span>
          </label>

          {suggestedValue.trim() ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setValue(suggestedValue.trim().slice(0, 4_096));
                setSaved(false);
              }}
            >
              使用当前输入作为偏好
            </Button>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">生效范围</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                ['project', '仅当前项目', '默认选择，减少跨项目干扰'],
                ['global', '所有项目', '适合稳定的长期输出习惯'],
              ] as const).map(([candidate, label, description]) => (
                <label key={candidate} className={`cursor-pointer rounded-xl border p-3 text-sm ${scope === candidate ? 'border-primary/50 bg-primary/5' : 'border-border'}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name="personal-memory-scope"
                      value={candidate}
                      checked={scope === candidate}
                      onChange={() => setScope(candidate)}
                      disabled={saving}
                    />
                    {label}
                  </span>
                  <span className="mt-1 block pl-5 text-xs leading-5 text-muted-foreground">{description}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border/60 bg-background/95 px-5 py-4 backdrop-blur">
          <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
            关闭
          </Button>
          <Button type="button" disabled={saving || !value.trim()} onClick={() => void save()}>
            {saving ? '正在保存…' : '确认并保存'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
