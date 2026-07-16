import './globals.css'
import type { Metadata } from 'next'
import GlobalSettingsProvider from '@/contexts/GlobalSettingsContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { AuthProvider } from '@/contexts/AuthContext'
import { AuthUserMenu } from '@/components/auth/AuthUserMenu'
import { getProjectAuthConfig } from '@/lib/config/auth'

// Auth mode is a deployment-time setting. Keep the root tree request-bound so
// one production image can safely switch between disabled and local auth.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: {
    default: 'QuantPilot · 量化研究工作台',
    template: '%s',
  },
  description: '从真实行情与证据出发，生成、评测和治理可验证的量化研究看板。',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const authConfig = getProjectAuthConfig();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=localStorage.getItem('quantpilot-color-mode')==='dark'?'dark':'light';document.documentElement.classList.toggle('dark',m==='dark');document.documentElement.style.colorScheme=m;}catch(e){}`,
          }}
        />
        {/* 加载稳定生成的 Tailwind CSS 兜底样式，避免开发时样式退化。 */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/generated/quantpilot-tailwind.css" />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          <AuthProvider enabled={authConfig.enabled}>
            <GlobalSettingsProvider>
              {children}
              <AuthUserMenu />
            </GlobalSettingsProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
