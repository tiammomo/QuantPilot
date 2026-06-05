import { PlatformRouteLoading } from '@/components/layout/PlatformRouteLoading';

export default function Loading() {
  return (
    <PlatformRouteLoading
      title="数据平台"
      subtitle="正在检查数据源、能力域、接口契约和降级状态..."
    />
  );
}
