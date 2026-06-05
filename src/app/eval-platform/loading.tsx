import { PlatformRouteLoading } from '@/components/layout/PlatformRouteLoading';

export default function Loading() {
  return (
    <PlatformRouteLoading
      title="评测平台"
      subtitle="正在读取评测集、测试用例、运行历史和最近报告..."
    />
  );
}
