import { Prisma } from '@prisma/client';

type JsonRecord = Record<string, unknown>;

export type NotificationDeliveryStatus = 'dry_run' | 'delivered' | 'failed' | 'skipped';

export interface ResearchNotificationChannelInput {
  id: string;
  name: string;
  channelType: string;
  target: string | null;
  config: Prisma.JsonValue;
  isDryRun: boolean;
}

export interface ResearchNotificationReportInput {
  id: string;
  title: string;
  summary: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
}

export interface ResearchNotificationResult {
  status: NotificationDeliveryStatus;
  channelType: string;
  title: string;
  payload: Prisma.InputJsonValue;
  error: string | null;
  deliveredAt: Date | null;
}

interface WebhookPayload {
  body: JsonRecord;
  preview: string;
}

const DEFAULT_WEBHOOK_ENV: Record<string, string> = {
  wxwork: 'QUANTPILOT_WXWORK_RESEARCH_WEBHOOK',
  feishu: 'QUANTPILOT_FEISHU_RESEARCH_WEBHOOK',
  dingtalk: 'QUANTPILOT_DINGTALK_RESEARCH_WEBHOOK',
  discord: 'QUANTPILOT_DISCORD_RESEARCH_WEBHOOK',
};

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  return {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function compactText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function resolveWebhookUrl(channel: ResearchNotificationChannelInput) {
  const config = asRecord(channel.config);
  const explicit = asString(config.webhookUrl) || asString(config.webhook_url);
  if (explicit) return { url: explicit, source: 'channel.config.webhookUrl' };

  const envName = asString(config.webhookEnv) || asString(config.webhook_env) || DEFAULT_WEBHOOK_ENV[channel.channelType];
  if (!envName) return { url: '', source: 'unsupported' };
  return { url: process.env[envName]?.trim() ?? '', source: envName };
}

function renderPlainText(report: ResearchNotificationReportInput) {
  return [
    report.title,
    '',
    report.summary,
    '',
    `评分：${report.score}/100`,
    `风险：${report.riskLevel}`,
    `建议：${report.recommendation}`,
  ].join('\n');
}

function renderMarkdown(report: ResearchNotificationReportInput) {
  return compactText(report.contentMarkdown, 3600);
}

function buildWebhookPayload(channel: ResearchNotificationChannelInput, report: ResearchNotificationReportInput): WebhookPayload | null {
  const markdown = renderMarkdown(report);
  const text = compactText(renderPlainText(report), 1800);

  if (channel.channelType === 'wxwork') {
    return {
      body: {
        msgtype: 'markdown',
        markdown: { content: markdown },
      },
      preview: markdown,
    };
  }

  if (channel.channelType === 'feishu') {
    return {
      body: {
        msg_type: 'text',
        content: { text },
      },
      preview: text,
    };
  }

  if (channel.channelType === 'dingtalk') {
    return {
      body: {
        msgtype: 'markdown',
        markdown: {
          title: report.title,
          text: markdown,
        },
      },
      preview: markdown,
    };
  }

  if (channel.channelType === 'discord') {
    return {
      body: {
        content: compactText(text, 1900),
      },
      preview: text,
    };
  }

  return null;
}

function parseWebhookFailure(channelType: string, body: unknown): string | null {
  const record = asRecord(body);
  const errcode = record.errcode;
  const code = record.code ?? record.StatusCode;

  if (channelType === 'wxwork' || channelType === 'dingtalk') {
    if (typeof errcode === 'number' && errcode !== 0) {
      return asString(record.errmsg, `webhook errcode=${errcode}`);
    }
  }

  if (channelType === 'feishu') {
    if (typeof code === 'number' && code !== 0) {
      return asString(record.msg ?? record.StatusMessage, `webhook code=${code}`);
    }
  }

  return null;
}

async function postWebhook(
  channel: ResearchNotificationChannelInput,
  webhookUrl: string,
  payload: WebhookPayload
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: controller.signal,
    });
    const responseText = await response.text().catch(() => '');
    let responseJson: unknown = null;
    if (responseText.trim()) {
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        responseJson = { raw: responseText.slice(0, 500) };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${responseText.slice(0, 240)}`,
        responseJson,
      };
    }

    const protocolError = parseWebhookFailure(channel.channelType, responseJson);
    if (protocolError) {
      return { ok: false, error: protocolError, responseJson };
    }

    return { ok: true, error: null, responseJson };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      responseJson: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverResearchReportNotification(params: {
  channel: ResearchNotificationChannelInput;
  report: ResearchNotificationReportInput;
  forceDryRun?: boolean;
}): Promise<ResearchNotificationResult> {
  const { channel, report } = params;
  const webhookPayload = buildWebhookPayload(channel, report);
  const webhook = resolveWebhookUrl(channel);
  const forceDryRun = params.forceDryRun ?? false;
  const title = report.title;

  if (!webhookPayload) {
    return {
      status: 'skipped',
      channelType: channel.channelType,
      title,
      payload: inputJson({
        adapter: 'unsupported',
        channelId: channel.id,
        channelName: channel.name,
      }),
      error: `暂不支持 ${channel.channelType} 推送 adapter`,
      deliveredAt: null,
    };
  }

  if (forceDryRun || channel.isDryRun) {
    return {
      status: 'dry_run',
      channelType: channel.channelType,
      title,
      payload: inputJson({
        adapter: `${channel.channelType}-webhook`,
        mode: 'dry_run',
        channelId: channel.id,
        channelName: channel.name,
        target: channel.target,
        webhookSource: webhook.source,
        webhookConfigured: Boolean(webhook.url),
        preview: compactText(webhookPayload.preview, 1200),
        reportId: report.id,
        score: report.score,
        riskLevel: report.riskLevel,
      }),
      error: null,
      deliveredAt: new Date(),
    };
  }

  if (!webhook.url) {
    return {
      status: 'failed',
      channelType: channel.channelType,
      title,
      payload: inputJson({
        adapter: `${channel.channelType}-webhook`,
        mode: 'real',
        channelId: channel.id,
        channelName: channel.name,
        target: channel.target,
        webhookSource: webhook.source,
        webhookConfigured: false,
        reportId: report.id,
      }),
      error: `缺少 ${channel.channelType} webhook，配置 ${webhook.source} 后再发送`,
      deliveredAt: null,
    };
  }

  const result = await postWebhook(channel, webhook.url, webhookPayload);

  return {
    status: result.ok ? 'delivered' : 'failed',
    channelType: channel.channelType,
    title,
    payload: inputJson({
      adapter: `${channel.channelType}-webhook`,
      mode: 'real',
      channelId: channel.id,
      channelName: channel.name,
      target: channel.target,
      webhookSource: webhook.source,
      webhookConfigured: true,
      reportId: report.id,
      score: report.score,
      riskLevel: report.riskLevel,
      response: result.responseJson ?? null,
    }),
    error: result.error,
    deliveredAt: result.ok ? new Date() : null,
  };
}
