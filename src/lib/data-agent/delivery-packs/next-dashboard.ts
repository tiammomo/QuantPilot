import type { DataAgentDeliveryPackDescriptor } from '../contracts';

export const NEXT_DASHBOARD_DELIVERY_PACK: DataAgentDeliveryPackDescriptor = {
  id: 'workspace.next-dashboard',
  version: '1.0.0',
  name: 'Next.js Data Workspace',
  description: '可验证、可预览的 Next.js 数据应用交付包，不包含任何金融业务语义。',
  supportedOutputs: ['answer', 'table', 'chart', 'dashboard', 'report', 'dataset'],
  workspaceDirectories: [
    '.data-agent',
    'data_file/raw',
    'data_file/intermediate',
    'data_file/final',
    'evidence',
    'scripts',
    'dashboard',
  ],
  artifactPaths: [
    '.data-agent/workspace.json',
    '.data-agent/profile.json',
    '.data-agent/events.jsonl',
    'data_file/final/dashboard-data.json',
    'evidence/sources.json',
  ],
  validatorIds: [
    'workspace.artifact-policy',
    'workspace.build',
    'workspace.preview-readiness',
  ],
};
