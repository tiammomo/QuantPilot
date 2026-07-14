"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BarChart3,
  Blocks,
  BookOpenCheck,
  BrainCircuit,
  FileChartColumn,
  Grid2X2,
  Home,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

const PRODUCTS = [
  { href: "/", label: "研究工作台", description: "发起研究与管理工作空间", icon: Home },
  { href: "/strategy-platform", label: "策略实验室", description: "筛选、回测与策略复盘", icon: BarChart3 },
  { href: "/research-reports", label: "投研情报", description: "观察池、日报与交付", icon: FileChartColumn },
  { href: "/business-knowledge", label: "业务知识", description: "能力、规范与数据契约", icon: BookOpenCheck },
  { href: "/skills", label: "Skills", description: "能力市场、版本与 Studio", icon: Blocks },
  { href: "/eval-platform", label: "评测平台", description: "契约与 DeepSeek E2E", icon: BrainCircuit },
  { href: "/ops-platform", label: "运行治理", description: "服务、任务与交付健康", icon: ShieldCheck },
] as const

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}

type PlatformSwitcherProps = {
  beforeNavigate?: (href: string) => boolean
}

export function PlatformSwitcher({ beforeNavigate }: PlatformSwitcherProps = {}) {
  const pathname = usePathname() ?? "/"

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 rounded-lg bg-background/70 px-2.5" aria-label="打开 QuantPilot 产品导航">
          <Grid2X2 className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">产品</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[min(92vw,420px)] overflow-y-auto border-border/70 p-0 sm:max-w-[420px]">
        <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12">
          <SheetTitle>QuantPilot 产品导航</SheetTitle>
          <SheetDescription>围绕同一研究任务，在分析、策略、交付、评测与治理之间切换。</SheetDescription>
        </SheetHeader>
        <nav className="grid gap-2 p-4" aria-label="QuantPilot 产品">
          {PRODUCTS.map((product) => {
            const Icon = product.icon
            const active = isActive(pathname, product.href)
            return (
              <SheetClose asChild key={product.href}>
                <Link
                  href={product.href}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    if (active || !beforeNavigate || beforeNavigate(product.href)) return
                    event.preventDefault()
                  }}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                    active
                      ? "border-primary/35 bg-primary/10 text-primary"
                      : "border-border/55 bg-card hover:border-primary/25 hover:bg-primary/5",
                  )}
                >
                  <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary")}>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{product.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{product.description}</span>
                  </span>
                </Link>
              </SheetClose>
            )
          })}
        </nav>
      </SheetContent>
    </Sheet>
  )
}
