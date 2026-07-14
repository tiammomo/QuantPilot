import { Activity } from 'lucide-react';

type PlatformRouteLoadingProps = {
  title: string;
  subtitle: string;
};

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

export function PlatformRouteLoading({ title, subtitle }: PlatformRouteLoadingProps) {
  return (
    <main className="platform-shell px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="platform-card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 animate-pulse text-primary" />
              <h1 className="text-lg font-semibold">{title}</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex gap-2">
            <SkeletonBlock className="h-8 w-20" />
            <SkeletonBlock className="h-8 w-24" />
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="platform-card p-4">
              <SkeletonBlock className="h-8 w-8" />
              <SkeletonBlock className="mt-4 h-5 w-20" />
              <SkeletonBlock className="mt-2 h-3 w-28" />
            </div>
          ))}
        </section>

        <section className="platform-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-4 py-3">
            <SkeletonBlock className="h-9 w-72 max-w-full" />
            <SkeletonBlock className="h-8 w-24" />
            <SkeletonBlock className="h-8 w-24" />
            <SkeletonBlock className="ml-auto h-8 w-28" />
          </div>
          <div className="divide-y divide-border/70">
            {[0, 1, 2, 3, 4, 5].map((item) => (
              <div key={item} className="grid gap-3 px-4 py-4 md:grid-cols-[220px_minmax(0,1fr)_140px]">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
