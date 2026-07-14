"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="platform-shell flex min-h-dvh items-center justify-center px-4 py-12">
      <section className="platform-card w-full max-w-lg px-6 py-10 text-center sm:px-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <TriangleAlert className="h-7 w-7" />
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">页面暂时无法完成请求</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          {error.message || "发生了未预期的错误，请稍后重试。"}
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-muted-foreground">错误标识：{error.digest}</p>
        )}
        <button
          onClick={reset}
          className="mx-auto mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:bg-primary/90"
        >
          <RotateCcw className="h-4 w-4" />
          重试
        </button>
      </section>
    </main>
  );
}
