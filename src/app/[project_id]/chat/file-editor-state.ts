export interface FileEditorState {
  selectedFile: string;
  content: string;
  editedContent: string;
  hasUnsavedChanges: boolean;
  isLoadingFile: boolean;
  fileLoadError: string | null;
  isSavingFile: boolean;
  saveFeedback: 'idle' | 'success' | 'error';
  saveError: string | null;
  isFileUpdating: boolean;
}

const initialState = (): FileEditorState => ({
  selectedFile: '', content: '', editedContent: '', hasUnsavedChanges: false,
  isLoadingFile: false, fileLoadError: null, isSavingFile: false,
  saveFeedback: 'idle', saveError: null, isFileUpdating: false,
});

/** One project owns one editor. Late reads and saves cannot replace another document. */
export class ProjectFileEditor {
  private state = initialState();
  private listeners = new Set<() => void>();
  private documentVersion = 0;
  private editVersion = 0;
  private readVersion = 0;
  private readController: AbortController | null = null;

  constructor(
    private projectId: string,
    private apiBase = '',
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<FileEditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  close = () => {
    this.documentVersion += 1;
    this.readVersion += 1;
    this.readController?.abort();
    this.state = initialState();
    for (const listener of this.listeners) listener();
  };

  edit = (value: string) => {
    if (!this.state.selectedFile || this.state.isLoadingFile || this.state.fileLoadError) return;
    this.editVersion += 1;
    this.update({
      editedContent: value, hasUnsavedChanges: value !== this.state.content,
      saveFeedback: 'idle', saveError: null, isFileUpdating: false,
    });
  };

  clearFeedback = () => this.update({ saveFeedback: 'idle', isFileUpdating: false });

  async open(filePath: string) {
    this.close();
    const documentVersion = this.documentVersion;
    const controller = new AbortController();
    this.readController = controller;
    this.update({ selectedFile: filePath, isLoadingFile: true });
    try {
      const response = await this.fetcher(
        `${this.apiBase}/api/repo/${encodeURIComponent(this.projectId)}/file?path=${encodeURIComponent(filePath)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`文件加载失败（HTTP ${response.status}）`);
      const data = await response.json();
      if (typeof data.content !== 'string') throw new Error('文件内容格式异常');
      if (documentVersion !== this.documentVersion || controller.signal.aborted) return;
      this.update({ content: data.content, editedContent: data.content, isLoadingFile: false });
    } catch (error) {
      if (documentVersion !== this.documentVersion || controller.signal.aborted) return;
      this.update({
        isLoadingFile: false,
        fileLoadError: error instanceof Error ? error.message : '文件加载失败',
      });
    }
  }

  async reload() {
    const { selectedFile, hasUnsavedChanges, isLoadingFile, isSavingFile } = this.state;
    if (!selectedFile || hasUnsavedChanges || isLoadingFile || isSavingFile) return;
    const documentVersion = this.documentVersion;
    const editVersion = this.editVersion;
    const readVersion = ++this.readVersion;
    try {
      const response = await this.fetcher(
        `${this.apiBase}/api/repo/${encodeURIComponent(this.projectId)}/file?path=${encodeURIComponent(selectedFile)}`,
      );
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.content !== 'string' || documentVersion !== this.documentVersion
        || editVersion !== this.editVersion || readVersion !== this.readVersion
        || this.state.isSavingFile) return;
      this.update({
        content: data.content, editedContent: data.content, hasUnsavedChanges: false,
        isFileUpdating: data.content !== this.state.content, fileLoadError: null,
        saveFeedback: 'idle', saveError: null,
      });
    } catch {
      // A background refresh leaves the visible document intact on failure.
    }
  }

  async save(): Promise<boolean> {
    const { selectedFile, editedContent, hasUnsavedChanges, isSavingFile, fileLoadError } = this.state;
    if (!selectedFile || !hasUnsavedChanges || isSavingFile || fileLoadError) return false;
    const documentVersion = this.documentVersion;
    // Invalidate a background read that began before this write.
    this.readVersion += 1;
    this.update({ isSavingFile: true, saveFeedback: 'idle', saveError: null });
    try {
      const response = await this.fetcher(
        `${this.apiBase}/api/repo/${encodeURIComponent(this.projectId)}/file`,
        {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: selectedFile, content: editedContent }),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || data?.message || `保存失败（HTTP ${response.status}）`);
      }
      if (documentVersion !== this.documentVersion) return false;
      this.update({
        content: editedContent,
        hasUnsavedChanges: this.state.editedContent !== editedContent,
        saveFeedback: 'success', isFileUpdating: true,
      });
      return true;
    } catch (error) {
      if (documentVersion === this.documentVersion) {
        this.update({ saveFeedback: 'error', saveError: error instanceof Error ? error.message : '保存失败' });
      }
      return false;
    } finally {
      if (documentVersion === this.documentVersion) this.update({ isSavingFile: false });
    }
  }
}
