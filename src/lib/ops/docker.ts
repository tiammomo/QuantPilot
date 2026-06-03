export type DockerContainerStatus = 'running' | 'stopped' | 'paused' | 'restarting' | 'unhealthy' | 'unknown';

export type DockerHealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface DockerPort {
  host: string | null;
  container: number;
  protocol: 'tcp' | 'udp';
}

export interface DockerHealthCheck {
  status: DockerHealthStatus;
  lastCheck: string | null;
  failCount: number;
}

export interface DockerResourceUsage {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
  networkRxMb: number;
  networkTxMb: number;
  blockReadMb: number;
  blockWriteMb: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  service: string;
  image: string;
  status: DockerContainerStatus;
  state: string;
  ports: DockerPort[];
  health: DockerHealthCheck;
  resources: DockerResourceUsage | null;
  createdAt: string;
  startedAt: string | null;
  uptime: string | null;
  restartCount: number;
  labels: Record<string, string>;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  size: string | null;
}

export interface DockerSystemInfo {
  serverVersion: string;
  storageDriver: string;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  totalImages: number;
  totalVolumes: number;
  os: string;
  architecture: string;
  cpuCount: number;
  totalMemoryGb: number;
}

export interface DockerDashboard {
  containers: DockerContainer[];
  volumes: DockerVolume[];
  system: DockerSystemInfo;
  composeProject: string;
  composeFile: string;
  generatedAt: string;
}

const now = new Date().toISOString();
const startedAt = new Date(Date.now() - 3600000 * 48).toISOString();

export function getMockDockerDashboard(): DockerDashboard {
  const containers: DockerContainer[] = [
    {
      id: 'a1b2c3d4e5f6',
      name: 'quantpilot-timescaledb-1',
      service: 'timescaledb',
      image: 'timescale/timescaledb:2.27.1-pg18',
      status: 'running',
      state: 'running (healthy)',
      ports: [{ host: '127.0.0.1', container: 5432, protocol: 'tcp' }],
      health: { status: 'healthy', lastCheck: now, failCount: 0 },
      resources: {
        cpuPercent: 2.4,
        memoryUsageMb: 312,
        memoryLimitMb: 2048,
        memoryPercent: 15.2,
        networkRxMb: 3.8,
        networkTxMb: 1.2,
        blockReadMb: 0.5,
        blockWriteMb: 45.6,
      },
      createdAt: '2026-03-15T10:30:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 0,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'timescaledb' },
    },
    {
      id: 'b2c3d4e5f6a7',
      name: 'quantpilot-redis-1',
      service: 'redis',
      image: 'redis:8-alpine',
      status: 'running',
      state: 'running (healthy)',
      ports: [{ host: '127.0.0.1', container: 6379, protocol: 'tcp' }],
      health: { status: 'healthy', lastCheck: now, failCount: 0 },
      resources: {
        cpuPercent: 0.3,
        memoryUsageMb: 8,
        memoryLimitMb: 256,
        memoryPercent: 3.1,
        networkRxMb: 0.5,
        networkTxMb: 0.2,
        blockReadMb: 0.1,
        blockWriteMb: 0.3,
      },
      createdAt: '2026-03-15T10:30:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 0,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'redis' },
    },
    {
      id: 'c3d4e5f6a7b8',
      name: 'quantpilot-clickhouse-1',
      service: 'clickhouse',
      image: 'clickhouse/clickhouse-server:25.8',
      status: 'running',
      state: 'running (healthy)',
      ports: [
        { host: '127.0.0.1', container: 8123, protocol: 'tcp' },
        { host: '127.0.0.1', container: 9000, protocol: 'tcp' },
      ],
      health: { status: 'healthy', lastCheck: now, failCount: 0 },
      resources: {
        cpuPercent: 5.1,
        memoryUsageMb: 512,
        memoryLimitMb: 4096,
        memoryPercent: 12.5,
        networkRxMb: 8.2,
        networkTxMb: 3.5,
        blockReadMb: 1.2,
        blockWriteMb: 120.3,
      },
      createdAt: '2026-03-15T10:30:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 2,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'clickhouse' },
    },
    {
      id: 'd4e5f6a7b8c9',
      name: 'quantpilot-loki-1',
      service: 'loki',
      image: 'grafana/loki:3.6.0',
      status: 'running',
      state: 'running',
      ports: [{ host: '127.0.0.1', container: 3100, protocol: 'tcp' }],
      health: { status: 'none', lastCheck: null, failCount: 0 },
      resources: {
        cpuPercent: 1.8,
        memoryUsageMb: 198,
        memoryLimitMb: 1024,
        memoryPercent: 19.3,
        networkRxMb: 6.4,
        networkTxMb: 2.1,
        blockReadMb: 0.3,
        blockWriteMb: 85.2,
      },
      createdAt: '2026-03-15T10:30:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 0,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'loki' },
    },
    {
      id: 'e5f6a7b8c9d0',
      name: 'quantpilot-grafana-1',
      service: 'grafana',
      image: 'grafana/grafana:13.0.1',
      status: 'running',
      state: 'running',
      ports: [{ host: '127.0.0.1', container: 3000, protocol: 'tcp' }],
      health: { status: 'none', lastCheck: null, failCount: 0 },
      resources: {
        cpuPercent: 1.2,
        memoryUsageMb: 145,
        memoryLimitMb: 512,
        memoryPercent: 28.3,
        networkRxMb: 2.1,
        networkTxMb: 0.9,
        blockReadMb: 0.2,
        blockWriteMb: 12.4,
      },
      createdAt: '2026-04-01T08:00:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 1,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'grafana' },
    },
    {
      id: 'f6a7b8c9d0e1',
      name: 'quantpilot-alloy-1',
      service: 'alloy',
      image: 'grafana/alloy:v1.16.1',
      status: 'running',
      state: 'running',
      ports: [{ host: null, container: 12345, protocol: 'tcp' }],
      health: { status: 'none', lastCheck: null, failCount: 0 },
      resources: {
        cpuPercent: 3.6,
        memoryUsageMb: 280,
        memoryLimitMb: 1024,
        memoryPercent: 27.3,
        networkRxMb: 12.5,
        networkTxMb: 8.7,
        blockReadMb: 0.6,
        blockWriteMb: 32.1,
      },
      createdAt: '2026-04-01T08:00:00Z',
      startedAt,
      uptime: '48 小时',
      restartCount: 3,
      labels: { 'com.docker.compose.project': 'quantpilot', 'com.docker.compose.service': 'alloy' },
    },
  ];

  const volumes: DockerVolume[] = [
    { name: 'quantpilot_timescaledb_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_timescaledb_data/_data', size: '2.3 GB' },
    { name: 'quantpilot_redis_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_redis_data/_data', size: '12 MB' },
    { name: 'quantpilot_clickhouse_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_clickhouse_data/_data', size: '4.1 GB' },
    { name: 'quantpilot_clickhouse_logs', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_clickhouse_logs/_data', size: '85 MB' },
    { name: 'quantpilot_loki_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_loki_data/_data', size: '1.2 GB' },
    { name: 'quantpilot_grafana_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_grafana_data/_data', size: '24 MB' },
    { name: 'quantpilot_alloy_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/quantpilot_alloy_data/_data', size: '18 MB' },
  ];

  const system: DockerSystemInfo = {
    serverVersion: '27.3.1',
    storageDriver: 'overlay2',
    totalContainers: 6,
    runningContainers: 6,
    stoppedContainers: 0,
    totalImages: 6,
    totalVolumes: 7,
    os: 'Ubuntu 24.04 LTS',
    architecture: 'x86_64',
    cpuCount: 16,
    totalMemoryGb: 32,
  };

  return {
    containers,
    volumes,
    system,
    composeProject: 'quantpilot',
    composeFile: 'docker-compose.yml',
    generatedAt: now,
  };
}
