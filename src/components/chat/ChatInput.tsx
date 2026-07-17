"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  CheckCircle2,
  Clock3,
  Image as ImageIcon,
  ListPlus,
  Loader2,
  MessageSquare,
  Pause,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  buildQuickQuestions,
  inferQuestionFocus,
  inferQuestionTimeRange,
  inferSymbolSearchQuery,
  QUESTION_COMPOSER_COPY,
  QUESTION_MODE_COPY,
  questionOutputLabel,
} from './question-composer';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export interface UploadedImage {
  id: string;
  filename: string;
  path: string;
  url: string;
  assetUrl?: string;
   publicUrl?: string;
}

interface ModelPickerOption {
  id: string;
  name: string;
  cli: string;
  cliName: string;
  available: boolean;
  supportsImages?: boolean;
}

interface CliPickerOption {
  id: string;
  name: string;
  available: boolean;
}

interface ChatInputProps {
  onSendMessage: (message: string, images?: UploadedImage[]) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: 'act' | 'chat';
  onModeChange?: (mode: 'act' | 'chat') => void;
  projectId?: string;
  projectName?: string;
  preferredCli?: string;
  selectedModel?: string;
  modelOptions?: ModelPickerOption[];
  onModelChange?: (option: ModelPickerOption) => void;
  modelChangeDisabled?: boolean;
  cliOptions?: CliPickerOption[];
  onCliChange?: (cliId: string) => void;
  cliChangeDisabled?: boolean;
  isRunning?: boolean;
  onPause?: () => void;
  isPausing?: boolean;
  queuedMessages?: Array<{ id: string; message: string }>;
  onRemoveQueuedMessage?: (id: string) => void;
}

interface ResolvedSymbol {
  symbol: string;
  name?: string;
  market?: string;
  asset_type?: string;
}

interface QueryRewritePreview {
  status?: 'ready' | 'partial' | 'needs_clarification' | 'refused';
  timeRange?: { label?: string } | null;
  analysisFocus?: { label?: string } | null;
  unresolvedTargets?: string[];
  safety?: {
    decision?: 'allow' | 'refuse';
    message?: string | null;
  };
}

export default function ChatInput({
  onSendMessage,
  disabled = false,
  placeholder = QUESTION_COMPOSER_COPY.defaultPlaceholder,
  mode = 'act',
  onModeChange,
  projectId,
  projectName = '',
  preferredCli = 'moagent',
  selectedModel = '',
  modelOptions = [],
  onModelChange,
  modelChangeDisabled = false,
  cliOptions = [],
  onCliChange,
  cliChangeDisabled = false,
  isRunning = false,
  onPause,
  isPausing = false,
  queuedMessages = [],
  onRemoveQueuedMessage,
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [resolvedSymbols, setResolvedSymbols] = useState<ResolvedSymbol[]>([]);
  const [queryRewritePreview, setQueryRewritePreview] = useState<QueryRewritePreview | null>(null);
  const [isResolvingSymbol, setIsResolvingSymbol] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionLockRef = useRef(false);
  const [loadedDraftStorageKey, setLoadedDraftStorageKey] = useState<string | null>(null);
  const supportsImageUpload = true;
  const draftStorageKey = projectId ? `quantpilot:question-draft:${projectId}` : null;

  const modelOptionsForCli = useMemo(
    () => modelOptions.filter(option => option.cli === preferredCli),
    [modelOptions, preferredCli]
  );

  const selectedModelValue = useMemo(() => {
    return modelOptionsForCli.some(opt => opt.id === selectedModel) ? selectedModel : '';
  }, [modelOptionsForCli, selectedModel]);
  const selectedModelOption = useMemo(
    () => modelOptionsForCli.find(opt => opt.id === selectedModel),
    [modelOptionsForCli, selectedModel]
  );
  const selectedModelSupportsImages = selectedModelOption?.supportsImages === true;
  const imageUploadTitle = selectedModelSupportsImages
    ? '上传图片，模型可直接识别图片内容'
    : '上传图片作为附件上下文；当前模型不支持原生视觉识别，Agent 会读取附件清单并标注需要人工确认的字段。';
  const symbolSearchQuery = useMemo(
    () => message.trim() ? inferSymbolSearchQuery(message, projectName) : null,
    [message, projectName],
  );
  const questionTimeRange = useMemo(() => inferQuestionTimeRange(message), [message]);
  const questionFocus = useMemo(() => inferQuestionFocus(message), [message]);
  const quickQuestions = useMemo(() => buildQuickQuestions(projectName), [projectName]);

  useEffect(() => {
    if (!disabled && !cliChangeDisabled && !modelChangeDisabled) {
      textareaRef.current?.focus();
    }
  }, [disabled, cliChangeDisabled, modelChangeDisabled]);

  useEffect(() => {
    if (!projectId || !draftStorageKey) return;
    setMessage(window.localStorage.getItem(draftStorageKey) ?? '');
    setLoadedDraftStorageKey(draftStorageKey);
  }, [draftStorageKey, projectId]);

  useEffect(() => {
    if (!projectId || !draftStorageKey || loadedDraftStorageKey !== draftStorageKey) return;
    if (message) {
      window.localStorage.setItem(draftStorageKey, message);
    } else {
      window.localStorage.removeItem(draftStorageKey);
    }
  }, [draftStorageKey, loadedDraftStorageKey, message, projectId]);

  useEffect(() => {
    const query = message.trim();
    if (!query) {
      setResolvedSymbols([]);
      setQueryRewritePreview(null);
      setIsResolvingSymbol(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsResolvingSymbol(true);
      try {
        const response = await fetch(`${API_BASE}/api/quant/query/rewrite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, purpose: 'preview' }),
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json();
        const rewrite = payload?.data;
        const results = rewrite?.resolvedSymbols;
        setResolvedSymbols(Array.isArray(results) ? results.slice(0, 3) : []);
        setQueryRewritePreview(rewrite && typeof rewrite === 'object' ? rewrite : null);
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setResolvedSymbols([]);
          setQueryRewritePreview(null);
        }
      } finally {
        if (!controller.signal.aborted) setIsResolvingSymbol(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [message]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }

    // Prevent multiple submissions with both state and ref locks
    if (isSubmitting || disabled || isUploading || submissionLockRef.current) {
      return;
    }

    if (!message.trim() && uploadedImages.length === 0) {
      return;
    }

    // Set both state and ref locks immediately
    setIsSubmitting(true);
    submissionLockRef.current = true;

    try {
      // Send message and images separately - unified_manager will add image references
      onSendMessage(message.trim(), uploadedImages);
      setMessage('');
      if (draftStorageKey) window.localStorage.removeItem(draftStorageKey);
      setUploadedImages([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = '40px';
      }
    } finally {
      // Reset submission locks after a reasonable delay
      setTimeout(() => {
        setIsSubmitting(false);
        submissionLockRef.current = false;
      }, 200);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Check all locks before submitting
      if (!isSubmitting && !disabled && !isUploading && !submissionLockRef.current && (message.trim() || uploadedImages.length > 0)) {
        handleSubmit();
      }
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = '40px';
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(scrollHeight, 200)}px`;
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('📸 File input change event triggered:', {
      hasFiles: !!e.target.files,
      fileCount: e.target.files?.length || 0,
      files: Array.from(e.target.files || []).map(f => ({
        name: f.name,
        size: f.size,
        type: f.type,
        lastModified: f.lastModified
      }))
    });

    const files = e.target.files;
    if (!files) {
      console.log('📸 No files selected');
      return;
    }

    console.log('📸 Calling handleFiles with files');
    await handleFiles(files);
  };

  const removeImage = (id: string) => {
    setUploadedImages(prev => {
      const imageToRemove = prev.find(img => img.id === id);
      if (imageToRemove) {
        URL.revokeObjectURL(imageToRemove.url);
      }
      return prev.filter(img => img.id !== id);
    });
  };

  // Handle files (for both drag drop and file input)
  const handleFiles = useCallback(async (files: FileList) => {
    if (!projectId) {
      console.error('❌ No project ID available for image upload');
      alert('当前没有可用项目，请先进入一个研究项目。');
      return;
    }

    console.log('📸 Starting image upload process:', {
      projectId,
      cli: preferredCli,
      fileCount: files.length
    });

    setIsUploading(true);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Check if file is an image
        if (!file.type.startsWith('image/')) {
          console.warn(`⚠️ Skipping non-image file: ${file.name}, type: ${file.type}`);
          continue;
        }

        console.log(`📸 Uploading image ${i + 1}/${files.length}:`, file.name);

        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/api/assets/${projectId}/upload`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Upload failed for ${file.name}:`, response.status, errorText);
          throw new Error(`Failed to upload ${file.name}: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ Image upload successful:', result);
        const imageUrl = URL.createObjectURL(file);

        const newImage: UploadedImage = {
          id: crypto.randomUUID(),
          filename: result.filename,
          path: result.path,
          url: imageUrl,
          assetUrl: `/api/assets/${projectId}/${result.filename}`,
          publicUrl: typeof result.public_url === 'string' ? result.public_url : undefined
        };

        console.log('📸 Created UploadedImage object:', newImage);
        setUploadedImages(prev => {
          const updatedImages = [...prev, newImage];
          console.log('📸 Updated uploadedImages state:', {
            totalCount: updatedImages.length,
            images: updatedImages.map(img => ({
              id: img.id,
              filename: img.filename,
              hasPath: !!img.path,
              hasAssetUrl: !!img.assetUrl,
              hasPublicUrl: !!img.publicUrl
            }))
          });
          return updatedImages;
        });
      }
    } catch (error) {
      console.error('❌ Image upload failed:', error);
      alert('图片上传失败，请重试。');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [projectId, preferredCli]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [message]);

  // Handle clipboard paste for images
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!projectId || !supportsImageUpload) return;
      
      const items = e.clipboardData?.items;
      if (!items) return;
      
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      
      if (imageFiles.length > 0) {
        e.preventDefault();
        const fileList = {
          length: imageFiles.length,
          item: (index: number) => imageFiles[index],
          [Symbol.iterator]: function* () {
            for (let i = 0; i < imageFiles.length; i++) {
              yield imageFiles[i];
            }
          }
        } as FileList;
        
        // Convert to FileList-like object
        Object.defineProperty(fileList, 'length', { value: imageFiles.length });
        imageFiles.forEach((file, index) => {
          Object.defineProperty(fileList, index, { value: file });
        });
        
        handleFiles(fileList);
      }
    };
    
    document.addEventListener('paste', handlePaste);
    
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [projectId, supportsImageUpload, handleFiles]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('📸 Drag enter event triggered:', { projectId, supportsImageUpload });
    if (projectId && supportsImageUpload) {
      setIsDragOver(true);
    } else {
      console.log('📸 Drag enter ignored: missing projectId or unsupported CLI');
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (projectId && supportsImageUpload) {
      e.dataTransfer.dropEffect = 'copy';
    } else {
      e.dataTransfer.dropEffect = 'none';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    console.log('📸 Drop event triggered:', {
      hasFiles: !!e.dataTransfer.files,
      fileCount: e.dataTransfer.files?.length || 0,
      projectId,
      supportsImageUpload,
      files: Array.from(e.dataTransfer.files || []).map(f => ({
        name: f.name,
        size: f.size,
        type: f.type
      }))
    });

    if (!projectId || !supportsImageUpload) {
      console.log('📸 Drop event blocked: missing projectId or unsupported CLI');
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      console.log('📸 Calling handleFiles with dropped files');
      handleFiles(files);
    } else {
      console.log('📸 No files in drop event');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`bg-white border rounded-2xl shadow-sm overflow-hidden transition-all duration-200 relative ${
      isDragOver
        ? 'border-blue-400 bg-blue-50'
        : 'border-slate-200'
    }`}
    >
      <div className="p-3">
        {/* 拖拽上传遮罩 */}
        {isDragOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-blue-50 bg-opacity-95 rounded-2xl z-10 pointer-events-none">
            <div className="text-blue-600 text-lg font-medium mb-2">将图片拖到这里</div>
            <div className="text-blue-500 text-sm">拖拽图片文件即可上传</div>
            <div className="mt-4">
              <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-amber-900">
              <span>已排队 {queuedMessages.length} 条补充要求</span>
              <span className="font-normal text-amber-700">当前任务结束后自动执行</span>
            </div>
            <div className="mt-1.5 space-y-1">
              {queuedMessages.slice(0, 2).map((queued, index) => (
                <div key={queued.id} className="flex items-center gap-2 text-xs text-amber-900">
                  <span className="shrink-0 text-amber-600">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{queued.message}</span>
                  {onRemoveQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onRemoveQueuedMessage(queued.id)}
                      className="rounded-full p-0.5 text-amber-700 hover:bg-amber-100 hover:text-amber-950"
                      aria-label={`移除排队要求：${queued.message}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!message.trim() && (
          <div className="platform-nav-scroll mb-1.5 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {quickQuestions.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => {
                  setMessage(question);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
              >
                {question}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full ring-offset-background placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 resize-none text-[15px] leading-6 md:text-sm bg-transparent focus:bg-transparent rounded-md px-2 py-2 text-slate-900 border-0"
            id="chatinput"
            aria-label="向 QuantPilot 发送消息"
            placeholder={isRunning ? QUESTION_COMPOSER_COPY.runningPlaceholder : placeholder}
            disabled={disabled || isUploading || isSubmitting}
            style={{ minHeight: '84px' }}
          />
          {isDragOver && projectId && supportsImageUpload && (
            <div className="pointer-events-none absolute inset-0 bg-blue-50/90 rounded-md flex items-center justify-center z-10 border-2 border-dashed border-blue-500">
              <div className="text-center">
                <div className="text-2xl mb-2">📸</div>
                <div className="text-sm font-medium text-blue-600 ">
                  将图片拖到这里
                </div>
                <div className="text-xs text-blue-500 mt-1">
                  支持：JPG、PNG、GIF、WEBP
                </div>
              </div>
            </div>
          )}
        </div>

        {message.trim() && (
          <div className="mx-1 mt-1.5 rounded-xl border border-slate-200/80 bg-slate-50/80 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {QUESTION_COMPOSER_COPY.recognitionTitle}
              <span className="font-normal text-slate-400">{QUESTION_COMPOSER_COPY.recognitionHelper}</span>
            </div>
            {queryRewritePreview?.safety?.decision === 'refuse' && (
              <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
                {queryRewritePreview.safety.message}
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {isResolvingSymbol ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {QUESTION_COMPOSER_COPY.resolvingTarget}
                </span>
              ) : resolvedSymbols.length > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                  <CheckCircle2 className="h-3 w-3" />
                  {resolvedSymbols[0].name || symbolSearchQuery} · {resolvedSymbols[0].symbol}{resolvedSymbols[0].market ? `.${resolvedSymbols[0].market}` : ''}
                  {resolvedSymbols.length > 1 ? ` +${resolvedSymbols.length - 1}` : ''}
                </span>
              ) : symbolSearchQuery ? (
                <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  {symbolSearchQuery} · {QUESTION_COMPOSER_COPY.pendingTargetVerification}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600">
                <Clock3 className="h-3 w-3" />
                {queryRewritePreview?.timeRange?.label || questionTimeRange}
              </span>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600">
                {queryRewritePreview?.analysisFocus?.label || questionFocus}
              </span>
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600">
                {questionOutputLabel(mode)}
              </span>
            </div>
          </div>
        )}

        {showAdvancedOptions && (
          <div className="mx-1 mt-2 grid gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-2 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] font-medium text-slate-500">
              执行引擎
              <select
                value={preferredCli}
                onChange={(event) => {
                  onCliChange?.(event.target.value);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                disabled={cliChangeDisabled || !onCliChange}
                className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                aria-label="选择执行引擎"
              >
                {cliOptions.length === 0 && <option value={preferredCli}>{preferredCli}</option>}
                {cliOptions.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.name}{!option.available ? '（不可用）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-slate-500">
              分析模型
              <select
                value={selectedModelValue}
                onChange={(event) => {
                  const option = modelOptionsForCli.find((item) => item.id === event.target.value);
                  if (option) {
                    onModelChange?.(option);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }
                }}
                disabled={modelChangeDisabled || !onModelChange || modelOptionsForCli.length === 0}
                className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                aria-label="选择分析模型"
              >
                {modelOptionsForCli.length === 0 && <option value="">暂无可用模型</option>}
                {modelOptionsForCli.length > 0 && selectedModelValue === '' && <option value="" disabled>选择模型</option>}
                {modelOptionsForCli.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.name}{!option.available ? '（不可用）' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {projectId && (
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={imageUploadTitle}
                aria-label={imageUploadTitle}
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.click();
                  }
                }}
              >
                <ImageIcon className="h-4 w-4" />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleImageUpload}
                  disabled={isUploading || disabled}
                  className="hidden"
                />
              </button>
            )}
            <div className="flex items-center rounded-full border border-slate-200 bg-white p-0.5">
              <button
                type="button"
                onClick={() => onModeChange?.('act')}
                aria-pressed={mode === 'act'}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                  mode === 'act' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
                title={QUESTION_MODE_COPY.act.description}
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>{QUESTION_MODE_COPY.act.label}</span>
              </button>
              <button
                type="button"
                onClick={() => onModeChange?.('chat')}
                aria-pressed={mode === 'chat'}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                  mode === 'chat' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
                title={QUESTION_MODE_COPY.chat.description}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>{QUESTION_MODE_COPY.chat.label}</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowAdvancedOptions((visible) => !visible)}
              aria-expanded={showAdvancedOptions}
              className={`flex h-8 items-center gap-1 rounded-full px-2 text-xs transition-colors ${
                showAdvancedOptions ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
              title={QUESTION_COMPOSER_COPY.advancedSettingsDescription}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {QUESTION_COMPOSER_COPY.advancedSettings}
            </button>
            <span className="hidden text-[10px] text-slate-400 xl:inline">Enter 发送 · Shift+Enter 换行</span>
          </div>

          {isRunning && (
            <Button
              type="button"
              onClick={onPause}
              size="icon"
              variant="destructive"
              className="size-8 shrink-0 rounded-full"
              disabled={isPausing || !onPause}
              title="暂停当前任务"
              aria-label="暂停当前任务"
            >
              <Pause className="h-4 w-4" />
            </Button>
          )}
          <Button
            id="chatinput-send-message-button"
            type="submit"
            variant="default"
            className="h-8 shrink-0 rounded-full px-3 text-xs transition-all duration-150 ease-out hover:scale-[1.03] disabled:hover:scale-100"
            disabled={disabled || isSubmitting || isUploading || (!message.trim() && uploadedImages.length === 0)}
            title={isRunning ? '加入补充要求队列' : '发送消息'}
            aria-label={isRunning ? '加入补充要求队列' : '发送消息'}
          >
            {isRunning ? <ListPlus className="h-4 w-4" /> : <SendHorizontal className="h-4 w-4" />}
            <span>{isRunning ? '加入要求' : '发送'}</span>
          </Button>
        </div>

      </div>

      {/* Uploaded Images Preview */}
      {uploadedImages.length > 0 && (
        <div className="px-4 pb-3">
          <div className="flex flex-wrap gap-2">
            {uploadedImages.map((image, index) => (
              <div key={image.id} className="relative group">
                <div className="w-16 h-16 bg-slate-100 rounded-lg overflow-hidden border border-slate-300">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.filename}
                    className="w-full h-full object-cover"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="移除图片"
                  aria-label={`移除图片 ${image.filename}`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs px-1 py-0.5 rounded-b-lg truncate">
                  {image.filename}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {uploadedImages.length} 张图片已上传
            {!selectedModelSupportsImages ? ' · 当前模型会作为附件上下文处理' : ' · 可直接识图'}
          </div>
        </div>
      )}
    </form>
  );
}
