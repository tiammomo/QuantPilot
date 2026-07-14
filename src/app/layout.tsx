import './globals.css'
import GlobalSettingsProvider from '@/contexts/GlobalSettingsContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { AuthProvider } from '@/contexts/AuthContext'

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
          <AuthProvider>
            <GlobalSettingsProvider>
              {children}
            </GlobalSettingsProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
