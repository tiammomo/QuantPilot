-- QuantPilot Prisma baseline at Git revision c641c00 (before durable MoAgent tables).
-- Fresh databases apply this migration normally. An existing database that is
-- already at this exact application schema must mark this migration as applied;
-- see ../README.md. Never run this SQL manually against an existing database.

BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "preview_url" TEXT,
    "preview_port" INTEGER,
    "repo_path" TEXT,
    "initial_prompt" TEXT,
    "template_type" TEXT,
    "active_claude_session_id" TEXT,
    "preferred_cli" TEXT,
    "selected_model" TEXT,
    "fallback_enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata_json" TEXT,
    "parent_message_id" TEXT,
    "session_id" TEXT,
    "conversation_id" TEXT,
    "duration_ms" INTEGER,
    "token_count" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "commit_sha" TEXT,
    "cli_source" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "session_type" TEXT NOT NULL,
    "cli_type" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "model_name" TEXT,
    "context_tokens" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_service_connections" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "service_data" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_sync_at" TIMESTAMP(3),

    CONSTRAINT "project_service_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "env_vars" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'runtime',
    "var_type" TEXT NOT NULL DEFAULT 'string',
    "is_secret" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "env_vars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_email" TEXT NOT NULL,
    "committed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_usages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "message_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "tool_input" TEXT NOT NULL,
    "tool_output" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_requests" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "cli_preference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "user_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tokens" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_used" TIMESTAMP(3),

    CONSTRAINT "service_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "strategy_scan_runs" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "best_result_id" TEXT,
    "objective" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_scan_jobs" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "run_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_watchlists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "universe_id" TEXT,
    "symbols" JSONB NOT NULL,
    "markets" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "schedule" JSONB NOT NULL,
    "report_template" TEXT NOT NULL DEFAULT 'daily_brief',
    "notification_channel_ids" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_report_runs" (
    "id" TEXT NOT NULL,
    "watchlist_id" TEXT,
    "status" TEXT NOT NULL,
    "run_type" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "model" TEXT,
    "provider_mode" TEXT NOT NULL DEFAULT 'local',
    "metadata" JSONB NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_reports" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "watchlist_id" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "report_date" TIMESTAMP(3) NOT NULL,
    "market_scope" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "recommendation" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "content_markdown" TEXT NOT NULL,
    "structured" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'local-market-data',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'configured',
    "target" TEXT,
    "config" JSONB NOT NULL,
    "is_dry_run" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "report_id" TEXT,
    "channel_id" TEXT,
    "status" TEXT NOT NULL,
    "channel_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "report_created_at" TIMESTAMP(3) NOT NULL,
    "mtime_ms" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "total" INTEGER NOT NULL,
    "passed_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "pass_rate" INTEGER NOT NULL,
    "average_score" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_queue_items" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cli" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoning_effort" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL DEFAULT 'rule-strict',
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'contract',
    "selected_cases" JSONB NOT NULL,
    "limit" INTEGER,
    "keep_projects" BOOLEAN NOT NULL,
    "report_id" TEXT,
    "report_path" TEXT,
    "log_path" TEXT,
    "pid" INTEGER,
    "exit_code" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_repair_tickets" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "report_path" TEXT NOT NULL,
    "project_id" TEXT,
    "failures" JSONB NOT NULL,
    "validation_summaries" JSONB NOT NULL,
    "suggested_actions" JSONB NOT NULL,
    "skill_versions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_schedules" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "interval_hours" INTEGER NOT NULL,
    "cli" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoning_effort" TEXT NOT NULL,
    "selected_cases" JSONB NOT NULL,
    "limit" INTEGER,
    "keep_projects" BOOLEAN NOT NULL,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_queued_run_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_project_id_idx" ON "messages"("project_id");

-- CreateIndex
CREATE INDEX "messages_session_id_idx" ON "messages"("session_id");

-- CreateIndex
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");

-- CreateIndex
CREATE INDEX "messages_project_id_created_at_idx" ON "messages"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_cli_source_idx" ON "messages"("cli_source");

-- CreateIndex
CREATE INDEX "messages_request_id_idx" ON "messages"("request_id");

-- CreateIndex
CREATE INDEX "sessions_project_id_idx" ON "sessions"("project_id");

-- CreateIndex
CREATE INDEX "sessions_cli_type_idx" ON "sessions"("cli_type");

-- CreateIndex
CREATE INDEX "project_service_connections_project_id_idx" ON "project_service_connections"("project_id");

-- CreateIndex
CREATE INDEX "project_service_connections_provider_idx" ON "project_service_connections"("provider");

-- CreateIndex
CREATE INDEX "env_vars_project_id_idx" ON "env_vars"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "env_vars_project_id_key_key" ON "env_vars"("project_id", "key");

-- CreateIndex
CREATE INDEX "commits_project_id_idx" ON "commits"("project_id");

-- CreateIndex
CREATE INDEX "commits_committed_at_idx" ON "commits"("committed_at");

-- CreateIndex
CREATE INDEX "tool_usages_project_id_idx" ON "tool_usages"("project_id");

-- CreateIndex
CREATE INDEX "tool_usages_message_id_idx" ON "tool_usages"("message_id");

-- CreateIndex
CREATE INDEX "tool_usages_tool_name_idx" ON "tool_usages"("tool_name");

-- CreateIndex
CREATE INDEX "user_requests_project_id_idx" ON "user_requests"("project_id");

-- CreateIndex
CREATE INDEX "user_requests_status_idx" ON "user_requests"("status");

-- CreateIndex
CREATE INDEX "service_tokens_provider_idx" ON "service_tokens"("provider");

-- CreateIndex
CREATE INDEX "strategy_scan_runs_template_id_idx" ON "strategy_scan_runs"("template_id");

-- CreateIndex
CREATE INDEX "strategy_scan_runs_scan_id_idx" ON "strategy_scan_runs"("scan_id");

-- CreateIndex
CREATE INDEX "strategy_scan_runs_completed_at_idx" ON "strategy_scan_runs"("completed_at");

-- CreateIndex
CREATE INDEX "strategy_scan_jobs_template_id_idx" ON "strategy_scan_jobs"("template_id");

-- CreateIndex
CREATE INDEX "strategy_scan_jobs_scan_id_idx" ON "strategy_scan_jobs"("scan_id");

-- CreateIndex
CREATE INDEX "strategy_scan_jobs_status_idx" ON "strategy_scan_jobs"("status");

-- CreateIndex
CREATE INDEX "strategy_scan_jobs_created_at_idx" ON "strategy_scan_jobs"("created_at");

-- CreateIndex
CREATE INDEX "research_watchlists_status_idx" ON "research_watchlists"("status");

-- CreateIndex
CREATE INDEX "research_watchlists_updated_at_idx" ON "research_watchlists"("updated_at");

-- CreateIndex
CREATE INDEX "research_report_runs_watchlist_id_idx" ON "research_report_runs"("watchlist_id");

-- CreateIndex
CREATE INDEX "research_report_runs_status_idx" ON "research_report_runs"("status");

-- CreateIndex
CREATE INDEX "research_report_runs_started_at_idx" ON "research_report_runs"("started_at");

-- CreateIndex
CREATE INDEX "research_reports_run_id_idx" ON "research_reports"("run_id");

-- CreateIndex
CREATE INDEX "research_reports_watchlist_id_idx" ON "research_reports"("watchlist_id");

-- CreateIndex
CREATE INDEX "research_reports_report_date_idx" ON "research_reports"("report_date");

-- CreateIndex
CREATE INDEX "notification_channels_channel_type_idx" ON "notification_channels"("channel_type");

-- CreateIndex
CREATE INDEX "notification_channels_status_idx" ON "notification_channels"("status");

-- CreateIndex
CREATE INDEX "notification_deliveries_run_id_idx" ON "notification_deliveries"("run_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_report_id_idx" ON "notification_deliveries"("report_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_channel_id_idx" ON "notification_deliveries"("channel_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries"("status");

-- CreateIndex
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries"("created_at");

-- CreateIndex
CREATE INDEX "eval_runs_report_created_at_idx" ON "eval_runs"("report_created_at");

-- CreateIndex
CREATE INDEX "eval_runs_passed_idx" ON "eval_runs"("passed");

-- CreateIndex
CREATE INDEX "eval_queue_items_status_idx" ON "eval_queue_items"("status");

-- CreateIndex
CREATE INDEX "eval_queue_items_created_at_idx" ON "eval_queue_items"("created_at");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_run_id_idx" ON "eval_repair_tickets"("run_id");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_case_id_idx" ON "eval_repair_tickets"("case_id");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_status_idx" ON "eval_repair_tickets"("status");

-- CreateIndex
CREATE INDEX "eval_repair_tickets_created_at_idx" ON "eval_repair_tickets"("created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_service_connections" ADD CONSTRAINT "project_service_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_usages" ADD CONSTRAINT "tool_usages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_usages" ADD CONSTRAINT "tool_usages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_requests" ADD CONSTRAINT "user_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_scan_jobs" ADD CONSTRAINT "strategy_scan_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "strategy_scan_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_report_runs" ADD CONSTRAINT "research_report_runs_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "research_watchlists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_report_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "research_watchlists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_report_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "research_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
