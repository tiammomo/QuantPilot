import {
  CheckCircle2,
  Diff,
  Download,
  History,
  Loader2,
  PackageCheck,
  RotateCcw,
  Rocket,
  UploadCloud,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes, type SkillDiffData, type SkillsPayload } from '@/components/quant/skills-source-tree';

export function SkillsVersionManagerDialog({
  open,
  selectedSkill,
  sourceDirty,
  releaseVersion,
  releaseSummary,
  releaseChanges,
  uploadFile,
  diffData,
  isPublishing,
  isUploading,
  isLoadingDiff,
  rollingBackVersion,
  isDraggingUpload,
  onClose,
  onVersionChange,
  onSummaryChange,
  onChangesChange,
  onLoadDiff,
  onPublish,
  onRollback,
  onUpload,
  onPackageDrop,
  onPackageDragOver,
  onPackageDragLeave,
  onPackageSelect,
}: {
  open: boolean;
  selectedSkill: SkillsPayload['skills'][number] | null;
  sourceDirty: boolean;
  releaseVersion: string;
  releaseSummary: string;
  releaseChanges: string;
  uploadFile: File | null;
  diffData: SkillDiffData | null;
  isPublishing: boolean;
  isUploading: boolean;
  isLoadingDiff: boolean;
  rollingBackVersion: string | null;
  isDraggingUpload: boolean;
  onClose: () => void;
  onVersionChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onChangesChange: (value: string) => void;
  onLoadDiff: () => void;
  onPublish: () => void;
  onRollback: (version: string) => void;
  onUpload: () => void;
  onPackageDrop: (event: React.DragEvent<HTMLLabelElement>) => void;
  onPackageDragOver: (event: React.DragEvent<HTMLLabelElement>) => void;
  onPackageDragLeave: () => void;
  onPackageSelect: (file: File | null) => void;
}) {
  if (!open || !selectedSkill) return null;

  return (
    <div className="fixed inset-0 z-50 max-w-full overflow-x-hidden bg-black/20 p-3 backdrop-blur-sm sm:p-4">
      <div className="mx-auto flex h-full max-h-[calc(100vh-32px)] max-w-7xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-4 sm:gap-4 sm:px-6 sm:py-5">
          <div className="flex items-center gap-4">
            <div className="hidden h-14 w-14 items-center justify-center rounded-full bg-violet-50 text-violet-600 sm:flex">
              <History className="h-7 w-7" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-normal text-gray-950 sm:text-2xl">版本管理</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                QuantPilot Skills 管理 · Skill: {selectedSkill.id}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-gray-950"
            aria-label="关闭版本管理"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="min-w-0 px-4 py-4 sm:px-6 sm:py-5">
            <div className="max-w-full overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="bg-muted/40 text-xs font-semibold text-gray-500">
                  <tr>
                    <th className="w-[150px] px-4 py-3">版本号</th>
                    <th className="px-4 py-3">变更说明</th>
                    <th className="px-4 py-3">更新人</th>
                    <th className="px-4 py-3">更新时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedSkill.changelog.releases.length > 0 ? (
                    selectedSkill.changelog.releases.map((release) => {
                      const current = release.version === selectedSkill.version;
                      return (
                        <tr key={`${release.version}-${release.date}`} className="border-t">
                          <td className="px-4 py-4 font-semibold text-gray-950">
                            <div className="flex flex-wrap items-center gap-2">
                              v{release.version}
                              {current && (
                                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                  当前版本
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-gray-700">
                            <div className="max-w-xl">
                              <div>{release.summary || '-'}</div>
                              {release.changes.length > 0 && (
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {release.changes.join('；')}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">QuantPilot</td>
                          <td className="px-4 py-4 text-muted-foreground">{release.date}</td>
                          <td className="px-4 py-4">
                            <div className="flex justify-end gap-2 whitespace-nowrap">
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                onClick={() => onRollback(release.version)}
                                disabled={current || !release.snapshot?.exists || rollingBackVersion === release.version}
                              >
                                {rollingBackVersion === release.version ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-4 w-4" />
                                )}
                                回滚
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                asChild={current && selectedSkill.package.exists}
                                disabled={!current || !selectedSkill.package.exists}
                              >
                                {current && selectedSkill.package.exists ? (
                                  <a href={`/api/skills/${selectedSkill.id}/package`} download>
                                    <Download className="h-4 w-4" />
                                    下载
                                  </a>
                                ) : (
                                  <>
                                    <Download className="h-4 w-4" />
                                    下载
                                  </>
                                )}
                              </Button>
                              <Button type="button" size="sm" disabled>
                                <CheckCircle2 className="h-4 w-4" />
                                应用
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                        当前 skill 暂无版本记录。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-5">
              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Rocket className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">发布新版本</h3>
                    <p className="text-xs text-muted-foreground">更新 registry、changelog、lock 和压缩包。</p>
                  </div>
                </div>
                <div className="grid gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="release-version-dialog">版本号</Label>
                    <Input
                      id="release-version-dialog"
                      value={releaseVersion}
                      onChange={(event) => onVersionChange(event.target.value)}
                      placeholder="例如 0.3.3"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release-summary-dialog">发布摘要</Label>
                    <Input
                      id="release-summary-dialog"
                      value={releaseSummary}
                      onChange={(event) => onSummaryChange(event.target.value)}
                      placeholder="简短说明这次版本解决的问题"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release-changes-dialog">变更点</Label>
                    <Textarea
                      id="release-changes-dialog"
                      value={releaseChanges}
                      onChange={(event) => onChangesChange(event.target.value)}
                      className="min-h-[110px]"
                      placeholder={'每行一条，例如：\n增强持仓截图字段提取契约\n补充数据质量校验规则'}
                    />
                  </div>
                </div>
                <div className="mt-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                  发版前先加载变更对比，确认本地源码目录相对上一版包的改动后再发布。
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={onLoadDiff}
                  disabled={isLoadingDiff || sourceDirty}
                >
                  {isLoadingDiff ? <Loader2 className="h-4 w-4 animate-spin" /> : <Diff className="h-4 w-4" />}
                  生成发布前 Diff
                </Button>
                <Button
                  type="button"
                  className="mt-4 w-full"
                  onClick={onPublish}
                  disabled={isPublishing || sourceDirty || isLoadingDiff || !diffData}
                >
                  {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                  确认 Diff 后发布
                </Button>
                {sourceDirty && <p className="mt-2 text-xs text-amber-600">先保存源码，再发布版本。</p>}
                {!sourceDirty && !diffData && <p className="mt-2 text-xs text-muted-foreground">发布前需要先生成 Diff。</p>}
              </Card>

              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <Diff className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">发布前变更对比</h3>
                    <p className="text-xs text-muted-foreground">
                      对比当前源码和 {diffData?.baseVersion ? `v${diffData.baseVersion}` : '上一版包'}。
                    </p>
                  </div>
                </div>
                {diffData ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-md border bg-emerald-50 p-2 text-emerald-700">
                        新增 {diffData.totals.added}
                      </div>
                      <div className="rounded-md border bg-blue-50 p-2 text-blue-700">
                        修改 {diffData.totals.modified}
                      </div>
                      <div className="rounded-md border bg-red-50 p-2 text-red-700">
                        删除 {diffData.totals.deleted}
                      </div>
                    </div>
                    <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                      {diffData.files.length > 0 ? diffData.files.map((file) => (
                        <div key={`${file.status}-${file.path}`} className="rounded-md border bg-white p-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`rounded-full px-2 py-0.5 font-semibold ${
                              file.status === 'added'
                                ? 'bg-emerald-50 text-emerald-700'
                                : file.status === 'deleted'
                                  ? 'bg-red-50 text-red-700'
                                  : 'bg-blue-50 text-blue-700'
                            }`}>
                              {file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}
                            </span>
                            <span className="min-w-0 break-all font-mono text-gray-950">{file.path}</span>
                          </div>
                          <div className="mt-2 text-xs text-muted-foreground">
                            +{file.addedLines} / -{file.removedLines} · {formatBytes(file.currentSize ?? file.previousSize ?? 0)}
                          </div>
                          <pre className="mt-2 max-h-28 overflow-auto rounded bg-gray-950 p-2 text-[11px] leading-4 text-gray-100">
                            {file.preview.join('\n')}
                          </pre>
                        </div>
                      )) : (
                        <div className="rounded-md border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">
                          当前源码与上一版包一致，没有待发布变更。
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    点击左侧“生成发布前 Diff”后展示所有待发布改动。
                  </div>
                )}
              </Card>
            </div>

            <div className="mt-5">
              <Card className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2">
                  <UploadCloud className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="text-base font-semibold">上传新包</h3>
                    <p className="text-xs text-muted-foreground">支持 zip、tgz、tar.gz；包内需包含 SKILL.md。</p>
                  </div>
                </div>
                <label
                  htmlFor="skill-upload-dialog"
                  onDragOver={onPackageDragOver}
                  onDragLeave={onPackageDragLeave}
                  onDrop={onPackageDrop}
                  className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-8 text-center text-sm transition-colors ${
                    isDraggingUpload
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  <UploadCloud className="mb-2 h-5 w-5" />
                  {uploadFile ? uploadFile.name : '拖拽或点击选择 skill 压缩包'}
                  <input
                    id="skill-upload-dialog"
                    type="file"
                    accept=".zip,.tgz,.tar.gz,application/gzip,application/zip"
                    className="sr-only"
                    onChange={(event) => onPackageSelect(event.target.files?.[0] ?? null)}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={onUpload}
                  disabled={isUploading || !uploadFile || !releaseVersion || !releaseSummary || !releaseChanges}
                >
                  {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  上传并发布为当前版本
                </Button>
              </Card>
            </div>

          </div>
        </div>

        <div className="border-t bg-muted/40 p-4">
          <Button type="button" variant="secondary" className="w-full" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
