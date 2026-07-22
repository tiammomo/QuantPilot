"use client";

import { useCallback, useId, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Cpu,
  Image as ImageIcon,
  LayoutDashboard,
  MessageSquare,
  Paperclip,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { QuantCapabilityId } from "@/lib/domains/finance/capabilities";
import type { ActiveCliId } from "@/lib/utils/cliOptions";

interface ModelOption {
  id: string;
  name: string;
}

interface AssistantOption {
  id: string;
  name: string;
}

interface RoleModule {
  id: string;
  name: string;
  shortName?: string;
  description: string;
  capabilityId?: QuantCapabilityId;
  inputPlaceholder?: string;
  inputHint?: string;
}

interface UploadedImage {
  id: string;
  name: string;
  url: string;
  path: string;
  file?: File;
}

type CreateTaskOutputMode = "act" | "chat";

interface CreateTaskFormProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  isCreating: boolean;
  onSubmit: () => void;
  uploadedImages: UploadedImage[];
  onImagesChange: (images: UploadedImage[]) => void;
  selectedAssistant: ActiveCliId;
  onAssistantChange: (id: string) => void;
  assistantOptions: AssistantOption[];
  isAssistantSelectable: (id: string) => boolean;
  selectedModel: string;
  onModelChange: (id: string) => void;
  modelOptions: ModelOption[];
  selectedRole: RoleModule;
  onRoleChange?: (id: QuantCapabilityId) => void;
  /** Image-only tasks are disabled by default; opt in only when the downstream workflow explicitly supports them. */
  allowImageOnly?: boolean;
  /** Defaults to dashboard generation and can be controlled by the parent when it is ready to persist the choice. */
  outputMode?: CreateTaskOutputMode;
  onOutputModeChange?: (mode: CreateTaskOutputMode) => void;
}

interface CreateTaskSubmitKey {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

interface CreateTaskSubmissionState {
  canSubmit: boolean;
  validationMessage: string | null;
}

const IMAGE_ONLY_VALIDATION_MESSAGE = "已添加图片，请补充文字说明后再开始研究。";

function getCreateTaskSubmissionState(
  prompt: string,
  uploadedImageCount: number,
  allowImageOnly = false
): CreateTaskSubmissionState {
  const hasPrompt = prompt.trim().length > 0;
  const hasImages = uploadedImageCount > 0;
  const isBlockedImageOnly = hasImages && !hasPrompt && !allowImageOnly;

  return {
    canSubmit: hasPrompt || (hasImages && allowImageOnly),
    validationMessage: isBlockedImageOnly ? IMAGE_ONLY_VALIDATION_MESSAGE : null,
  };
}

function shouldSubmitCreateTaskFromKeyDown({
  key,
  shiftKey,
  isComposing = false,
  keyCode,
}: CreateTaskSubmitKey): boolean {
  return key === "Enter" && !shiftKey && !isComposing && keyCode !== 229;
}

function CreateTaskForm({
  prompt,
  onPromptChange,
  isCreating,
  onSubmit,
  uploadedImages,
  onImagesChange,
  selectedAssistant,
  onAssistantChange,
  assistantOptions,
  isAssistantSelectable,
  selectedModel,
  onModelChange,
  modelOptions,
  selectedRole,
  allowImageOnly = false,
  outputMode,
  onOutputModeChange,
}: CreateTaskFormProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [uncontrolledOutputMode, setUncontrolledOutputMode] = useState<CreateTaskOutputMode>("act");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const fileInputId = useId();
  const validationMessageId = useId();
  const submissionState = getCreateTaskSubmissionState(prompt, uploadedImages.length, allowImageOnly);
  const isSubmitDisabled = !submissionState.canSubmit || isCreating || isUploading;
  const selectedOutputMode = outputMode ?? uncontrolledOutputMode;

  const submitIfValid = () => {
    if (isSubmitDisabled) return;
    onSubmit();
  };

  const changeOutputMode = (nextMode: CreateTaskOutputMode) => {
    if (outputMode === undefined) setUncontrolledOutputMode(nextMode);
    onOutputModeChange?.(nextMode);
  };

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (isCreating || isUploading) return;
      setIsUploading(true);
      try {
        const filesArray = Array.from(files as ArrayLike<File>);
        const imagesToAdd = filesArray
          .filter((file) => file.type.startsWith("image/"))
          .map((file) => ({
            id: crypto.randomUUID(),
            name: file.name,
            url: URL.createObjectURL(file),
            path: "",
            file,
          }));

        if (imagesToAdd.length > 0) {
          onImagesChange([...uploadedImages, ...imagesToAdd]);
        }
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [isCreating, isUploading, uploadedImages, onImagesChange]
  );

  const removeImage = (id: string) => {
    onImagesChange(
      uploadedImages.filter((img) => {
        if (img.id === id && img.url) URL.revokeObjectURL(img.url);
        return img.id !== id;
      })
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submitIfValid();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "relative w-full overflow-hidden rounded-[1.5rem] border bg-card/92 text-card-foreground shadow-[0_22px_60px_-38px_hsl(var(--shadow-color)/0.5)] ring-1 ring-white/70 backdrop-blur-xl transition-all before:pointer-events-none before:absolute before:inset-x-10 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/30 before:to-transparent focus-within:border-primary/45 focus-within:shadow-[0_28px_68px_-40px_hsl(var(--primary)/0.5)] dark:ring-white/5",
        isDragOver
          ? "border-primary"
          : "border-border/75"
      )}
    >
      {/* Uploaded image previews */}
      {uploadedImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-5 pt-4">
          {uploadedImages.map((image, index) => (
            <div key={image.id} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.name}
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">
                图 {index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                disabled={isCreating}
                className="group/remove absolute -right-3 -top-3 flex h-11 w-11 items-center justify-center rounded-full opacity-100 transition-opacity disabled:cursor-not-allowed disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                aria-label={`移除图片 ${image.name}`}
              >
                <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-xs text-white shadow-sm transition-colors group-hover/remove:bg-destructive/80">×</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <Textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        aria-label="量化分析需求"
        placeholder={selectedRole.inputPlaceholder ?? selectedRole.inputHint ?? "描述你的金融分析需求..."}
        disabled={isCreating}
        aria-invalid={submissionState.validationMessage ? true : undefined}
        aria-describedby={submissionState.validationMessage ? validationMessageId : undefined}
        className="min-h-[96px] resize-none border-0 bg-transparent px-5 pb-3 pt-4 text-base leading-7 shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0 md:min-h-[112px] md:px-6 md:pt-5"
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (shouldSubmitCreateTaskFromKeyDown({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: isComposingRef.current || e.nativeEvent.isComposing,
            keyCode: e.keyCode,
          })) {
            e.preventDefault();
            submitIfValid();
          }
        }}
      />

      {submissionState.validationMessage ? (
        <p
          id={validationMessageId}
          role="alert"
          className="mx-5 mb-3 -mt-1 text-xs font-medium text-amber-700 dark:text-amber-300 md:mx-6"
        >
          {submissionState.validationMessage}
        </p>
      ) : null}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.5rem] border-2 border-dashed border-primary bg-background/95">
          <div className="text-center text-primary">
            <ImageIcon className="mx-auto mb-2 h-6 w-6" />
            <p className="text-sm font-semibold">将图片拖到这里</p>
            <p className="mt-1 text-xs">支持 JPG、PNG、GIF、WEBP</p>
          </div>
        </div>
      )}

      {showAdvanced ? (
        <div className="grid border-t border-border/45 bg-muted/[0.1] px-4 py-1.5 sm:grid-cols-2 sm:divide-x sm:divide-border">
          <div className="flex min-w-0 items-center gap-2 py-1 sm:pr-3">
            <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Agent</span>
            <Select value={selectedAssistant} onValueChange={onAssistantChange}>
              <SelectTrigger aria-label="选择分析助手" className="h-11 min-h-11 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs font-semibold shadow-none">
                <SelectValue placeholder="助手" />
              </SelectTrigger>
              <SelectContent>
                {assistantOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id} disabled={!isAssistantSelectable(opt.id)} className="min-h-11">{opt.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {modelOptions.length > 0 ? (
            <div className="flex min-w-0 items-center gap-2 border-t border-border/50 py-1 sm:border-t-0 sm:pl-3">
              <Cpu className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">模型</span>
              <Select value={selectedModel} onValueChange={onModelChange}>
                <SelectTrigger aria-label="选择分析模型" className="h-11 min-h-11 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs font-semibold shadow-none">
                  <SelectValue placeholder="模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => <SelectItem key={model.id} value={model.id} className="min-h-11">{model.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 bg-background/55 px-3 py-2">
        {/* Upload button */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="上传图片"
          aria-controls={fileInputId}
          disabled={isUploading || isCreating}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          onChange={(e) => e.currentTarget.files && handleFiles(e.currentTarget.files)}
          disabled={isUploading || isCreating}
          className="hidden"
        />

        {/* Capability badge */}
        <div className="flex min-w-0 max-w-28 items-center gap-1.5 border-l border-border/60 px-2 py-1 sm:max-w-40">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {selectedRole.shortName ?? selectedRole.name}
          </span>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAdvanced((current) => !current)}
          aria-expanded={showAdvanced}
          className={cn("h-11 min-h-11 gap-1.5 rounded-lg px-2 text-xs", showAdvanced ? "bg-primary/[0.08] text-primary hover:bg-primary/[0.12]" : "text-muted-foreground")}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="sm:hidden">高级</span>
          <span className="hidden sm:inline">高级设置</span>
        </Button>

        <span className="ml-auto hidden text-[10px] text-muted-foreground/75 lg:inline">Enter 发送 · Shift + Enter 换行</span>

        <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
          <div
            role="group"
            aria-label="输出方式"
            className="grid min-w-0 flex-1 grid-cols-2 rounded-xl border border-border/70 bg-muted/45 p-0.5 sm:flex sm:flex-none"
          >
            <button
              type="button"
              aria-label="生成看板"
              aria-pressed={selectedOutputMode === "act"}
              disabled={isCreating}
              onClick={() => changeOutputMode("act")}
              className={cn(
                "flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-24",
                selectedOutputMode === "act"
                  ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              <span>生成看板</span>
            </button>
            <button
              type="button"
              aria-label="只做问答"
              aria-pressed={selectedOutputMode === "chat"}
              disabled={isCreating}
              onClick={() => changeOutputMode("chat")}
              className={cn(
                "flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-24",
                selectedOutputMode === "chat"
                  ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>只做问答</span>
            </button>
          </div>

          {/* Submit button */}
          <Button
            type="submit"
            disabled={isSubmitDisabled}
            aria-describedby={submissionState.validationMessage ? validationMessageId : undefined}
            className="h-11 min-h-11 shrink-0 gap-1.5 rounded-xl bg-gradient-to-r from-[#c94b38] to-[#a93425] px-3 text-xs font-semibold text-white shadow-[0_12px_28px_-14px_rgba(169,52,37,0.72)] hover:from-[#bd4938] hover:to-[#982f22]"
            aria-label="提交任务"
          >
            {isCreating ? (
              <svg
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <><ArrowUp className="h-4 w-4" />开始研究</>
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

export {
  CreateTaskForm,
  getCreateTaskSubmissionState,
  shouldSubmitCreateTaskFromKeyDown,
};
export type {
  CreateTaskFormProps,
  CreateTaskOutputMode,
  CreateTaskSubmissionState,
  UploadedImage,
};
