import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CreateTaskForm,
  getCreateTaskSubmissionState,
  shouldSubmitCreateTaskFromKeyDown,
  type CreateTaskFormProps,
} from "./CreateTaskForm";

const defaultProps: CreateTaskFormProps = {
  prompt: "分析贵州茅台近 60 个交易日的趋势",
  onPromptChange: () => undefined,
  isCreating: false,
  onSubmit: () => undefined,
  uploadedImages: [],
  onImagesChange: () => undefined,
  selectedAssistant: "moagent",
  onAssistantChange: () => undefined,
  assistantOptions: [{ id: "moagent", name: "MoAgent" }],
  isAssistantSelectable: () => true,
  selectedModel: "deepseek-v4-flash",
  onModelChange: () => undefined,
  modelOptions: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  selectedRole: {
    id: "stock_diagnosis",
    name: "股票诊断",
    shortName: "诊断",
    description: "分析股票的趋势、估值与风险。",
    capabilityId: "stock_diagnosis",
  },
};

function renderForm(overrides: Partial<CreateTaskFormProps> = {}) {
  return renderToStaticMarkup(React.createElement(CreateTaskForm, {
    ...defaultProps,
    ...overrides,
  }));
}

function elementTagByAriaLabel(html: string, element: "button" | "textarea", label: string) {
  return html.match(new RegExp(`<${element}[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

describe("CreateTaskForm submission reliability", () => {
  it("submits on a plain Enter but not while a Chinese IME is composing", () => {
    expect(shouldSubmitCreateTaskFromKeyDown({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitCreateTaskFromKeyDown({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitCreateTaskFromKeyDown({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(shouldSubmitCreateTaskFromKeyDown({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitCreateTaskFromKeyDown({ key: "a", shiftKey: false })).toBe(false);
  });

  it("blocks image-only tasks by default and allows an explicit opt-in", () => {
    expect(getCreateTaskSubmissionState("", 0)).toEqual({
      canSubmit: false,
      validationMessage: null,
    });
    expect(getCreateTaskSubmissionState("   ", 1)).toEqual({
      canSubmit: false,
      validationMessage: "已添加图片，请补充文字说明后再开始研究。",
    });
    expect(getCreateTaskSubmissionState("分析这张图", 1)).toEqual({
      canSubmit: true,
      validationMessage: null,
    });
    expect(getCreateTaskSubmissionState("", 1, true)).toEqual({
      canSubmit: true,
      validationMessage: null,
    });
  });

  it("renders an accessible inline error and a disabled submit button for image-only input", () => {
    const html = renderForm({
      prompt: "",
      uploadedImages: [{
        id: "image-1",
        name: "chart.png",
        url: "data:image/png;base64,AA==",
        path: "",
      }],
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("已添加图片，请补充文字说明后再开始研究。");
    expect(elementTagByAriaLabel(html, "textarea", "量化分析需求")).toContain('aria-invalid="true"');
    expect(elementTagByAriaLabel(html, "button", "提交任务")).toContain("disabled");
  });
});

describe("CreateTaskForm accessibility markup", () => {
  it("uses a focusable upload button and keeps the hidden file input out of the Tab order", () => {
    const html = renderForm();
    const uploadButton = elementTagByAriaLabel(html, "button", "上传图片");
    const fileInput = html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? "";

    expect(uploadButton).toContain('type="button"');
    expect(uploadButton).toContain("aria-controls=");
    expect(uploadButton).toContain("h-11");
    expect(uploadButton).toContain("w-11");
    expect(fileInput).toContain('tabindex="-1"');
    expect(fileInput).toContain('class="hidden"');
  });

  it("keeps every primary mobile interaction at least 44px high", () => {
    const html = renderForm({
      uploadedImages: [{
        id: "image-1",
        name: "chart.png",
        url: "data:image/png;base64,AA==",
        path: "",
      }],
    });
    const interactiveLabels = [
      "移除图片 chart.png",
      "上传图片",
      "选择分析助手",
      "选择分析模型",
      "生成看板",
      "只做问答",
      "提交任务",
    ];

    for (const label of interactiveLabels) {
      expect(elementTagByAriaLabel(html, "button", label), label).toContain("h-11");
    }
    expect(html.match(/<button[^>]*aria-expanded="true"[^>]*>/)?.[0] ?? "").toContain("h-11");
  });

  it("defaults to dashboard generation and exposes controlled output mode with aria-pressed", () => {
    const defaultHtml = renderForm();
    expect(elementTagByAriaLabel(defaultHtml, "button", "生成看板")).toContain('aria-pressed="true"');
    expect(elementTagByAriaLabel(defaultHtml, "button", "只做问答")).toContain('aria-pressed="false"');

    const chatHtml = renderForm({ outputMode: "chat" });
    expect(elementTagByAriaLabel(chatHtml, "button", "生成看板")).toContain('aria-pressed="false"');
    expect(elementTagByAriaLabel(chatHtml, "button", "只做问答")).toContain('aria-pressed="true"');
  });
});
