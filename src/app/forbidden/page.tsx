import Link from 'next/link';
import { ShieldX } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/25 px-6">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-600"><ShieldX className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-bold">没有访问权限</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">当前账号没有访问这个页面或资源的权限。</p>
        <Button className="mt-6" asChild><Link href="/">返回工作台</Link></Button>
      </div>
    </main>
  );
}
