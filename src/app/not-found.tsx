import Link from 'next/link';
import { ArrowLeft, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="platform-shell flex min-h-dvh items-center justify-center px-4 py-12">
      <section className="platform-card w-full max-w-lg px-6 py-10 text-center sm:px-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Compass className="h-7 w-7" />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-primary">404 · Route not found</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">这个页面不在当前航线中</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          地址可能已更新，或者对应的任务和评测记录已经不存在。
        </p>
        <Button asChild className="mt-7">
          <Link href="/">
            <ArrowLeft className="h-4 w-4" />
            返回 QuantPilot
          </Link>
        </Button>
      </section>
    </main>
  );
}
