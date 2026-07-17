import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AuthUserMenu } from "@/components/auth/AuthUserMenu"
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
  /** Hide the shared account entry when the surrounding shell already provides one. */
  showAccount?: boolean
  className?: string
}

function PageHeader({
  title,
  badge,
  subtitle,
  children,
  backHref = "/",
  compactOnMobile = false,
  showAccount = true,
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
              <Link href={backHref} aria-label={backHref === "/" ? "返回研究工作台" : "返回上一页"}>
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
          )}
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ee6b4d] to-[#d84d35] text-sm font-bold text-white shadow-[0_8px_20px_-10px_rgba(224,83,57,0.8)]",
            compactOnMobile && "max-[479px]:hidden",
          )}>
            <span aria-hidden="true">Q</span>
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
        <div className={cn("flex flex-wrap items-center gap-1.5 sm:gap-2 lg:justify-end", compactOnMobile && "shrink-0 flex-nowrap")}>
          {children}
          <PlatformSwitcher />
          <div className="max-[359px]:hidden">
            <ThemeToggle compact />
          </div>
          {showAccount ? <AuthUserMenu variant="header" /> : null}
        </div>
      </div>
    </header>
  )
}

export { PageHeader }
export type { PageHeaderProps }
