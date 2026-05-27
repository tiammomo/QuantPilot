import type { SkillsDashboardData } from '@/lib/quant/skills-dashboard';

export type SkillsPayload = SkillsDashboardData;
export type SourceFile = SkillsPayload['skills'][number]['source']['files'][number];
export type SourceDirectory = SkillsPayload['skills'][number]['source']['directories'][number];
export type SourceKind = SourceFile['kind'];

export type SourceState = {
  skillId: string;
  filePath: string;
  content: string;
  relativePath: string;
  size: number;
  updatedAt: string | null;
  editable: boolean;
  skillMd?: string;
};

export type SkillDiffFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  previousSize: number | null;
  currentSize: number | null;
  previousUpdatedAt: string | null;
  currentUpdatedAt: string | null;
  addedLines: number;
  removedLines: number;
  preview: string[];
};

export type SkillDiffData = {
  skillId: string;
  baseVersion: string | null;
  basePackagePath: string | null;
  changed: boolean;
  files: SkillDiffFile[];
  totals: {
    added: number;
    modified: number;
    deleted: number;
    addedLines: number;
    removedLines: number;
  };
};
