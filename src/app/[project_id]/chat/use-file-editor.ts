'use client';

import {
  useCallback, useEffect, useMemo, useRef, useSyncExternalStore,
  type ChangeEvent, type KeyboardEvent, type UIEvent,
} from 'react';
import { ProjectFileEditor } from './file-editor-state';

export function useFileEditor(params: {
  projectId: string;
  apiBase: string;
  showPreview: boolean;
  refreshPreview: () => void;
}) {
  const editor = useMemo(
    () => new ProjectFileEditor(params.projectId, params.apiBase),
    [params.projectId, params.apiBase],
  );
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { editor.close(); }, [editor]);
  useEffect(() => {
    if (state.saveFeedback !== 'success' && !state.isFileUpdating) return;
    const timer = setTimeout(editor.clearFeedback, 1800);
    return () => clearTimeout(timer);
  }, [editor, state.saveFeedback, state.isFileUpdating]);

  const synchronizeScroll = useCallback((element: HTMLTextAreaElement) => {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = element.scrollTop;
      highlightRef.current.scrollLeft = element.scrollLeft;
    }
    if (lineNumberRef.current) lineNumberRef.current.scrollTop = element.scrollTop;
  }, []);
  useEffect(() => {
    if (editorRef.current) synchronizeScroll(editorRef.current);
  }, [state.editedContent, synchronizeScroll]);

  const openFile = useCallback(async (filePath: string) => {
    const current = editor.getSnapshot();
    if (current.selectedFile === filePath && !current.fileLoadError) return;
    if (current.hasUnsavedChanges && !window.confirm('有未保存的修改，放弃修改并打开其他文件？')) return;
    await editor.open(filePath);
    if (editor.getSnapshot().selectedFile !== filePath) return;
    if (editorRef.current) {
      editorRef.current.scrollTop = 0;
      editorRef.current.scrollLeft = 0;
      synchronizeScroll(editorRef.current);
    }
  }, [editor, synchronizeScroll]);

  const closeFile = useCallback(() => {
    if (editor.getSnapshot().hasUnsavedChanges && !window.confirm('有未保存的修改，确认关闭？')) return;
    editor.close();
  }, [editor]);

  const reloadCurrentFile = useCallback(async () => {
    if (!params.showPreview) await editor.reload();
  }, [editor, params.showPreview]);

  const refreshPreview = params.refreshPreview;
  const handleSaveFile = useCallback(async () => {
    if (await editor.save()) refreshPreview();
  }, [editor, refreshPreview]);

  const onEditorChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    editor.edit(event.target.value);
  }, [editor]);

  const handleEditorScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    synchronizeScroll(event.currentTarget);
  }, [synchronizeScroll]);

  const handleEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void handleSaveFile();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const element = event.currentTarget;
      const start = element.selectionStart ?? 0;
      const end = element.selectionEnd ?? 0;
      const value = editor.getSnapshot().editedContent;
      editor.edit(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        element.selectionStart = start + 2;
        element.selectionEnd = start + 2;
        synchronizeScroll(element);
      });
    }
  }, [editor, handleSaveFile, synchronizeScroll]);

  return {
    ...state, editorRef, highlightRef, lineNumberRef,
    openFile, closeFile, reloadCurrentFile, handleSaveFile,
    onEditorChange, handleEditorScroll, handleEditorKeyDown,
    highlightedCode: state.editedContent || ' ',
  };
}
