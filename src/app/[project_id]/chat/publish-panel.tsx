'use client';
import { Rocket } from 'lucide-react';
import type { useProjectDeployment } from './use-project-deployment';

export function PublishPanel({
  deployment,
  onOpenSettings,
}: {
  deployment: ReturnType<typeof useProjectDeployment>;
  onOpenSettings: () => void;
}) {
  const {
    showPublishPanel,
    setShowPublishPanel,
    publishLoading,
    githubConnected,
    vercelConnected,
    publishedUrl,
    deploymentStatus,
    publish,
  } = deployment;
  return (
    showPublishPanel && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50" onClick={() => setShowPublishPanel(false)} />
        <div className="relative w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60 ">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-black border border-black/10 ">
                <Rocket size={14} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900 ">Publish Project</h3>
                <p className="text-xs text-slate-600 ">Deploy with Vercel, linked to your GitHub repo</p>
              </div>
            </div>
            <button onClick={() => setShowPublishPanel(false)} className="text-slate-400 hover:text-slate-600 ">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="p-6 space-y-4">
            {deploymentStatus === 'deploying' && (
              <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 ">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm font-medium text-blue-700 ">Deployment in progress…</p>
                </div>
                <p className="text-xs text-blue-700/80 ">
                  Building and deploying your project. This may take a few minutes.
                </p>
              </div>
            )}

            {deploymentStatus === 'ready' && publishedUrl && (
              <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 ">
                <p className="text-sm font-medium text-emerald-700 mb-2">Published successfully</p>
                <div className="flex items-center gap-2">
                  <a
                    href={publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-emerald-700 underline break-all flex-1"
                  >
                    {publishedUrl}
                  </a>
                  <button
                    onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                    className="px-2 py-1 text-xs rounded-lg border border-emerald-300/80 text-emerald-700 hover:bg-emerald-100 "
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {deploymentStatus === 'error' && (
              <div className="p-4 rounded-xl border border-red-200 bg-red-50 ">
                <p className="text-sm font-medium text-red-700 ">Deployment failed. Please try again.</p>
              </div>
            )}

            {!githubConnected || !vercelConnected ? (
              <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 ">
                <p className="text-sm font-medium text-slate-900 mb-2">Connect the following services:</p>
                <div className="space-y-1 text-amber-700 text-sm">
                  {!githubConnected && (
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      GitHub repository not connected
                    </div>
                  )}
                  {!vercelConnected && (
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      Vercel project not connected
                    </div>
                  )}
                </div>
                <button
                  className="mt-3 w-full px-4 py-2 rounded-xl border border-slate-200 text-slate-800 hover:bg-slate-50 "
                  onClick={() => {
                    setShowPublishPanel(false);
                    onOpenSettings();
                  }}
                >
                  Open Settings → Services
                </button>
              </div>
            ) : null}

            <button
              disabled={publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected}
              onClick={publish}
              className={`w-full px-4 py-3 rounded-xl font-medium text-white transition ${
                publishLoading || deploymentStatus === 'deploying' || !githubConnected || !vercelConnected
                  ? 'bg-slate-400 cursor-not-allowed'
                  : 'bg-black hover:bg-slate-900'
              }`}
            >
              {publishLoading
                ? 'Publishing…'
                : deploymentStatus === 'deploying'
                  ? 'Deploying…'
                  : !githubConnected || !vercelConnected
                    ? 'Connect Services First'
                    : deploymentStatus === 'ready' && publishedUrl
                      ? 'Update'
                      : 'Publish'}
            </button>
          </div>
        </div>
      </div>
    )
  );
}
