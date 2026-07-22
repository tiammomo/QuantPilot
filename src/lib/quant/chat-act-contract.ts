import { z } from 'zod';
import { MAX_DATA_AGENT_IMAGE_ATTACHMENTS } from '@/lib/data-agent';

export const MAX_CHAT_ACT_IMAGE_ATTACHMENTS = MAX_DATA_AGENT_IMAGE_ATTACHMENTS;

const boundedOptionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const projectAssetPathSchema = z.string().trim().min(1).max(2_048).refine((value) => {
  if (value.includes('\\') || value.includes('\0') || /[\r\n]/.test(value)) return false;
  if (!value.startsWith('assets/')) return false;
  const filename = value.slice('assets/'.length);
  return Boolean(filename) && !filename.includes('/') && filename !== '.' && filename !== '..';
}, 'Attachment path must be a project-relative assets/<filename> path.');

export const chatActImageAttachmentSchema = z.object({
  name: boundedOptionalText(256),
  path: projectAssetPathSchema,
  mimeType: z.string().trim().regex(/^image\/[a-z0-9.+-]+$/i).max(128).optional(),
}).strict();

export const chatActRequestSchema = z.object({
  instruction: z.string().max(200_000).default(''),
  displayInstruction: z.string().max(200_000).optional(),
  conversationId: boundedOptionalText(256),
  requestId: boundedOptionalText(256),
  selectedModel: boundedOptionalText(256),
  images: z.array(chatActImageAttachmentSchema).max(MAX_CHAT_ACT_IMAGE_ATTACHMENTS).default([]),
  isInitialPrompt: z.boolean().default(false),
  quantCapabilityId: boundedOptionalText(128),
  quantCapabilitySource: z.enum(['manual', 'default', 'inferred']).optional(),
}).strict().refine((value) => (
  value.instruction.trim().length > 0 ||
  (value.displayInstruction?.trim().length ?? 0) > 0 ||
  value.images.length > 0
), {
  message: 'instruction, displayInstruction or images is required.',
});

export type ChatActImageAttachment = z.infer<typeof chatActImageAttachmentSchema>;
export type ChatActRequest = z.infer<typeof chatActRequestSchema>;

export class ChatActContractError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(error: z.ZodError) {
    super('Invalid chat act request.');
    this.name = 'ChatActContractError';
    this.issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '$',
      message: issue.message,
    }));
  }
}

export function parseChatActRequest(input: unknown): ChatActRequest {
  const parsed = chatActRequestSchema.safeParse(input);
  if (!parsed.success) throw new ChatActContractError(parsed.error);
  return parsed.data;
}
