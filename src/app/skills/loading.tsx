import { PlatformRouteLoading } from '@/components/layout/PlatformRouteLoading';

export default function Loading() {
  return (
    <PlatformRouteLoading
      title="Skills 管理"
      subtitle="正在检查技能目录、源码状态、版本记录和发布健康度..."
    />
  );
}
