/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  output: 'standalone',
  // 关闭 critters 的 CSS 优化，避免构建时缺少可选依赖。
  experimental: {
    optimizeCss: false,
    scrollRestoration: true,
  },
  // 生成项目、数据快照和本地缓存不属于主应用运行时，避免 standalone tracing 误扫。
  outputFileTracingExcludes: {
    '*': [
      './data/projects/**/.next/**',
      './data/projects/**/node_modules/**',
      './data/projects/**/data_file/**',
      './data/projects/**/evidence/**',
      './backend/market_data/.venv/**',
      './tmp/**',
    ],
  },
  // 注入项目根路径，供前端读取当前工作区信息。
  env: {
    NEXT_PUBLIC_PROJECT_ROOT: process.cwd(),
  },
  // 为客户端构建禁用服务端模块兜底，避免 fs/path/os 被打进浏览器包。
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
