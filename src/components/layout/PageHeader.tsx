import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft, Orbit } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/ui/theme-toggle"
import { cn } from "@/lib/utils"
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher"

interface PageHeaderProps {
  title: string
  badge?: ReactNode
  subtitle?: string
  /** Right-side toolbar content: view switchers, refresh, actions */
  children?: ReactNode
  /** Replace default back-to-home link. Set to false to hide. */
  backHref?: string | false
  /** Keep the app bar on one row and hide secondary metadata on narrow screens. */
  compactOnMobile?: boolean
  className?: string
}

function PageHeader({
  title,
  badge,
  subtitle,
  children,
  backHref = "/",
  compactOnMobile = false,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("platform-header", className)}>
      <div className={cn(
        "flex min-h-[4.5rem] w-full items-stretch justify-between gap-3 px-4 py-3 lg:flex-row lg:items-center lg:px-6",
        compactOnMobile ? "flex-row items-center" : "flex-col",
      )}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {backHref !== false && (
            <Button variant="ghost" size="icon" asChild className="shrink-0">
              <Link href={backHref} aria-label="返回首页">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
          )}
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary shadow-sm",
            compactOnMobile && "max-[479px]:h-9 max-[479px]:w-9",
          )}>
            <Orbit className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className={cn("truncate text-xl font-bold tracking-tight text-foreground", compactOnMobile && "max-[479px]:text-lg")}>
                {title}
              </h1>
              {badge && <span className={cn("shrink-0", compactOnMobile && "max-[639px]:hidden")}>{badge}</span>}
            </div>
            {subtitle && (
              <p className={cn(
                "mt-0.5 max-w-[70vw] truncate text-xs text-muted-foreground",
                compactOnMobile && "max-[639px]:hidden",
              )}>{subtitle}</p>
            )}
          </div>
        </div>
        <div className={cn("flex flex-wrap items-center gap-2 lg:justify-end", compactOnMobile && "shrink-0")}>
          <PlatformSwitcher />
          <ThemeToggle compact />
          {children}
        </div>
      </div>
    </header>
  )
}

export { PageHeader }
export type { PageHeaderProps }
