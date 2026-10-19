CREATE TABLE `admin` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_username_unique` ON `admin` (`username`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`ip_allowlist_json` text,
	`rate_limit_per_min` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_prefix` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE TABLE `applied_nodes` (
	`node_id` text PRIMARY KEY NOT NULL,
	`outbound_tag` text NOT NULL,
	`inbound_tag` text NOT NULL,
	`rule_tag` text NOT NULL,
	`port` integer NOT NULL,
	`outbound_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_applied_outbound` ON `applied_nodes` (`outbound_tag`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`ip` text,
	`request_id` text,
	`detail_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `dataplane_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`outbounds_json` text,
	`inbounds_json` text,
	`rules_json` text,
	`digest` text
);
--> statement-breakpoint
CREATE INDEX `idx_dataplane_at` ON `dataplane_state` (`at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`node_id` text,
	`subscription_id` text,
	`revision_id` text,
	`message` text NOT NULL,
	`detail_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `gateway_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`updated_at` integer NOT NULL,
	`table_json` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`payload_json` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`message` text,
	`started_at` integer,
	`finished_at` integer,
	`result_json` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_status_created` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `node_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_node_aliases_node` ON `node_aliases` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_check_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`ok` integer NOT NULL,
	`stage_reached` text,
	`connect_ms` integer,
	`handshake_ms` integer,
	`total_ms` integer,
	`delay_ms` integer,
	`http_status` integer,
	`exit_ip` text,
	`exit_country` text,
	`error_kind` text,
	`error_msg` text,
	`detail_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_check_runs_node` ON `node_check_runs` (`node_id`,`at`);--> statement-breakpoint
CREATE TABLE `node_connections` (
	`id` integer PRIMARY KEY NOT NULL,
	`node_id` text,
	`username` text,
	`client_ip` text,
	`target` text,
	`started_at` integer NOT NULL,
	`closed_at` integer,
	`up_bytes` integer DEFAULT 0 NOT NULL,
	`down_bytes` integer DEFAULT 0 NOT NULL,
	`close_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_conns_node` ON `node_connections` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_conns_started` ON `node_connections` (`started_at`);--> statement-breakpoint
CREATE TABLE `node_credentials` (
	`node_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_enc` text NOT NULL,
	`password_lookup_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_node_cred_lookup` ON `node_credentials` (`password_lookup_hash`);--> statement-breakpoint
CREATE TABLE `node_port` (
	`node_id` text PRIMARY KEY NOT NULL,
	`port` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	`released_at` integer,
	`reusable_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_port_port_unique` ON `node_port` (`port`);--> statement-breakpoint
CREATE INDEX `idx_node_port_port` ON `node_port` (`port`);--> statement-breakpoint
CREATE TABLE `node_sources` (
	`node_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`name_in_sub` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `subscription_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_node_sources_sub` ON `node_sources` (`subscription_id`);--> statement-breakpoint
CREATE TABLE `node_status` (
	`node_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`last_check_at` integer,
	`last_ok_at` integer,
	`last_fail_at` integer,
	`recovered_at` integer,
	`connect_ms` integer,
	`handshake_ms` integer,
	`total_ms` integer,
	`delay_ms` integer,
	`exit_ip` text,
	`exit_country` text,
	`exit_region` text,
	`exit_asn` text,
	`exit_isp` text,
	`error_kind` text,
	`error_msg` text,
	`fail_streak` integer DEFAULT 0 NOT NULL,
	`success_streak` integer DEFAULT 0 NOT NULL,
	`next_check_at` integer,
	`checks_total` integer DEFAULT 0 NOT NULL,
	`checks_ok` integer DEFAULT 0 NOT NULL,
	`uptime_24h` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_node_status_state_next` ON `node_status` (`state`,`next_check_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`country_code` text,
	`region` text,
	`protocol` text NOT NULL,
	`fingerprint` text NOT NULL,
	`params_hash` text NOT NULL,
	`outbound_json` text NOT NULL,
	`protocol_supported` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`publish_policy_override` text,
	`is_virtual` integer DEFAULT 0 NOT NULL,
	`check_depth` text DEFAULT 'full' NOT NULL,
	`publish_error` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`missing_since` integer,
	`stale_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_fingerprint_unique` ON `nodes` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_nodes_country` ON `nodes` (`country_code`);--> statement-breakpoint
CREATE INDEX `idx_nodes_enabled_missing` ON `nodes` (`enabled`,`missing_since`);--> statement-breakpoint
CREATE INDEX `idx_nodes_protocol` ON `nodes` (`protocol`);--> statement-breakpoint
CREATE INDEX `idx_nodes_fingerprint` ON `nodes` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `pending_retire` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tag` text NOT NULL,
	`node_id` text,
	`revision_id` text,
	`retire_after` integer NOT NULL,
	`done_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_pending_retire_due` ON `pending_retire` (`done_at`,`retire_after`);--> statement-breakpoint
CREATE TABLE `revision_nodes` (
	`revision_id` text NOT NULL,
	`node_id` text NOT NULL,
	`username` text,
	`outbound_tag` text,
	`inbound_tag` text,
	`inbound_port` integer,
	PRIMARY KEY(`revision_id`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `runtime_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	`retired_at` integer,
	`node_count` integer DEFAULT 0 NOT NULL,
	`added_count` integer DEFAULT 0 NOT NULL,
	`removed_count` integer DEFAULT 0 NOT NULL,
	`changed_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`plan_digest` text,
	`plan_json` text,
	`validation_json` text,
	`dataplane_before_json` text,
	`dataplane_after_json` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_revisions_status` ON `runtime_revisions` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_token` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_run_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`line_no` integer,
	`raw_snippet` text,
	`error_kind` text,
	`error_msg` text
);
--> statement-breakpoint
CREATE TABLE `subscription_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`http_status` integer,
	`bytes` integer,
	`duration_ms` integer,
	`total_found` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`changed` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`restored` integer DEFAULT 0 NOT NULL,
	`unsupported` integer DEFAULT 0 NOT NULL,
	`parse_errors` integer DEFAULT 0 NOT NULL,
	`error_kind` text,
	`error_msg` text,
	`result_digest` text
);
--> statement-breakpoint
CREATE INDEX `idx_subruns_sub` ON `subscription_runs` (`subscription_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`format_hint` text DEFAULT 'auto' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`interval_sec` integer,
	`cron` text,
	`timeout_ms` integer DEFAULT 20000 NOT NULL,
	`retries` integer DEFAULT 2 NOT NULL,
	`retry_backoff_ms` integer DEFAULT 1500 NOT NULL,
	`concurrency` integer DEFAULT 3 NOT NULL,
	`headers_json` text,
	`user_agent` text,
	`sub_id_override` text,
	`last_sync_at` integer,
	`last_status` text DEFAULT 'never' NOT NULL,
	`last_error` text,
	`last_error_kind` text,
	`etag` text,
	`last_modified` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`content_text` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_url_unique` ON `subscriptions` (`url`);--> statement-breakpoint
CREATE TABLE `xray_apply_ops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text,
	`at` integer NOT NULL,
	`op` text NOT NULL,
	`tag` text,
	`payload_json` text,
	`ok` integer NOT NULL,
	`duration_ms` integer,
	`stdout` text,
	`stderr` text,
	`error_kind` text
);
--> statement-breakpoint
CREATE INDEX `idx_apply_ops_op` ON `xray_apply_ops` (`op`);--> statement-breakpoint
CREATE INDEX `idx_apply_ops_at` ON `xray_apply_ops` (`at`);