'use client';

import { ArrowRight, BarChart3, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import Image from 'next/image';
import { FormEvent, useState } from 'react';

import loginHero from '@/assets/login-quant-anime-researcher-v2.webp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth/client';
import { resolveLoginEmail } from '@/lib/auth/login-identity';

function safeNextPath(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export default function LoginClient({
  nextPath,
  rememberMe,
  developmentAdmin,
}: {
  nextPath?: string;
  rememberMe: boolean;
  developmentAdmin: { login: string; email: string } | null;
}) {
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const result = await authClient.signIn.email({
        email: resolveLoginEmail(identity, developmentAdmin),
        password,
        rememberMe,
      });
      if (result.error) {
        setError(result.error.status === 429
          ? '尝试次数过多，请稍后再试。'
          : '邮箱或密码不正确。');
        return;
      }
      window.location.assign(safeNextPath(nextPath));
    } catch {
      setError('暂时无法连接登录服务，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-background px-4 py-5 text-foreground sm:px-6 sm:py-8 lg:flex lg:items-center lg:justify-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_0%,hsl(var(--primary)/0.12),transparent_30rem),radial-gradient(circle_at_92%_100%,hsl(var(--info)/0.09),transparent_34rem)]" />
      <div className="pointer-events-none absolute left-[8%] top-[12%] h-28 w-28 rounded-full border border-primary/10 bg-primary/5 blur-sm" />
      <div className="pointer-events-none absolute bottom-[8%] right-[7%] h-40 w-40 rounded-full border border-info/10 bg-info/5 blur-sm" />

      <div className="relative mx-auto grid w-full max-w-6xl overflow-hidden rounded-[2rem] border border-border/80 bg-card shadow-[0_28px_90px_-42px_hsl(var(--shadow-color)/0.42)] lg:min-h-[720px] lg:grid-cols-[1.08fr_0.92fr]">
        <section className="relative min-h-[260px] overflow-hidden border-b border-border/70 bg-muted lg:min-h-[720px] lg:border-b-0 lg:border-r">
          <Image
            src={loginHero}
            alt="动漫风格的 QuantPilot 量化研究员正在分析数据"
            fill
            priority
            sizes="(min-width: 1024px) 55vw, 100vw"
            className="object-cover object-[50%_42%] lg:object-[50%_44%]"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/30 via-transparent to-white/10" />

          <div className="absolute left-5 top-5 flex items-center gap-2.5 rounded-2xl border border-white/70 bg-white/80 px-3 py-2 text-sm font-bold tracking-tight text-slate-900 shadow-sm backdrop-blur-md sm:left-7 sm:top-7 sm:px-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <BarChart3 className="h-5 w-5" />
            </span>
            QuantPilot
          </div>

          <div className="absolute bottom-7 left-7 right-7 hidden rounded-3xl border border-white/75 bg-white/82 p-6 text-slate-950 shadow-[0_18px_48px_-24px_rgba(15,23,42,0.28)] backdrop-blur-xl lg:block">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              AI 驱动的量化研究工作台
            </div>
            <h1 className="max-w-lg text-3xl font-bold leading-tight tracking-[-0.035em]">
              从清晰的问题开始，抵达可验证的研究结论。
            </h1>
            <p className="mt-3 max-w-lg text-sm leading-6 text-slate-600">
              连接真实数据、Skills 与 Agent Runtime，让每一次分析都有依据、有过程、有结果。
            </p>
          </div>
        </section>

        <section className="flex items-center bg-card px-6 py-10 sm:px-12 sm:py-14 lg:min-h-[720px] lg:px-14">
          <div className="mx-auto w-full max-w-md">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary">
              <ShieldCheck className="h-3.5 w-3.5" />
              安全访问
            </div>
            <h2 className="mt-5 text-3xl font-bold tracking-[-0.03em] sm:text-4xl">欢迎回来</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">登录后继续访问你的项目、策略与研究工作台。</p>

            <form className="mt-9 space-y-5" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="identity" className="text-sm font-semibold">账号或邮箱</Label>
                <Input
                  id="identity"
                  name="identity"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={identity}
                  onChange={(event) => setIdentity(event.target.value)}
                  className="h-12 rounded-xl border-input bg-background px-4 shadow-sm placeholder:text-muted-foreground/65 focus-visible:ring-primary"
                  placeholder="admin 或 name@example.com"
                />
                {developmentAdmin ? (
                  <p className="inline-flex rounded-lg bg-primary/[0.07] px-2.5 py-1.5 text-xs font-medium text-primary">本地默认：admin / admin</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-semibold">密码</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl border-input bg-background px-4 shadow-sm focus-visible:ring-primary"
                />
              </div>

              {error ? (
                <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={isSubmitting || !identity || !password}
                className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-[0_14px_32px_-18px_hsl(var(--primary)/0.8)] transition-transform hover:-translate-y-0.5 hover:bg-primary/90"
              >
                {isSubmitting ? '正在验证…' : '登录'}
                {!isSubmitting ? <ArrowRight className="h-4 w-4" /> : null}
              </Button>
            </form>

            <div className="mt-8 rounded-2xl border border-border/75 bg-muted/45 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm"><LockKeyhole className="h-4 w-4" /></span>
                <p className="text-xs leading-5 text-muted-foreground">
                  密码使用 Argon2id 保护，会话仅保存在 HttpOnly Cookie 中；
                  {rememberMe ? '有效期由项目会话策略控制。' : '关闭浏览器后需要重新登录。'}
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
