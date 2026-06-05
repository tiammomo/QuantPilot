import { PlatformRouteLoading } from '@/components/layout/PlatformRouteLoading';

export default function Loading() {
  return (
    <PlatformRouteLoading
      title="策略平台"
      subtitle="正在读取策略目录、股票池、因子和回测数据..."
    />
  );
}
