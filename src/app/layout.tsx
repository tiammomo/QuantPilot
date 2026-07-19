import './globals.css'
import type { Metadata } from 'next'
import { MotionConfig } from 'framer-motion'
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
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/quantpilot-mark.svg?v=2', type: 'image/svg+xml' },
      { url: '/favicon-32.png?v=2', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png?v=2', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon-32.png?v=2',
    apple: [{ url: '/apple-touch-icon.png?v=2', sizes: '180x180', type: 'image/png' }],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const authConfig = getProjectAuthConfig();
  const includeStableCssFallback = process.env.QUANTPILOT_STABLE_CSS_FALLBACK === '1';
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=localStorage.getItem('quantpilot-color-mode')==='dark'?'dark':'light';document.documentElement.classList.toggle('dark',m==='dark');document.documentElement.style.colorScheme=m;}catch(e){}`,
          }}
        />
        {includeStableCssFallback ? (
          <>
            {/* Explicit diagnostics fallback only. Normal runtime already receives globals.css from Next. */}
            {/* eslint-disable-next-line @next/next/no-css-tags */}
            <link rel="stylesheet" href="/generated/quantpilot-tailwind.css" />
          </>
        ) : null}
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          <AuthProvider enabled={authConfig.enabled}>
            <GlobalSettingsProvider>
              <MotionConfig reducedMotion="user">
                {children}
                <AuthUserMenu />
              </MotionConfig>
            </GlobalSettingsProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
