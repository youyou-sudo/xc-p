/**
 * 数据模型的唯一来源（drizzle）。
 *
 * 由 data/sb.db 的真实 DDL 反推生成，与 core/migrations.ts v1-v3 已应用的库结构一一对应。
 * 改表流程：改这里 -> bun run db:generate -> 把产出的 SQL 放进 drizzle/ 作为 v4+ 迁移。
 *
 * 注意：v1-v3 已经上线，**不要回改历史迁移**；schema 的作用是类型与 diff 基准，
 * 新装库由 v1-v3 建表，存量库按 schema_migrations 跳过它们。
 *
 * I have nothing but my burger and I want nothing more
 */

import { sqliteTable, integer, text, real, index, primaryKey } from 'drizzle-orm/sqlite-core'

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer().primaryKey(),
  name: text().notNull(),
  applied_at: integer('applied_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value_json: text('value_json').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const admin = sqliteTable('admin', {
  id: integer().primaryKey(),
  username: text().notNull().unique(),
  password_hash: text('password_hash').notNull(),
  totp_secret: text('totp_secret'),
  updated_at: integer('updated_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text().primaryKey(),
  token_hash: text('token_hash').notNull(),
  ip: text(),
  user_agent: text('user_agent'),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  revoked_at: integer('revoked_at'),
},

  (table) => [
    index('idx_sessions_token').on(table.token_hash),
  ])

export const apiKeys = sqliteTable('api_keys', {
  id: text().primaryKey(),
  name: text().notNull(),
  prefix: text().notNull(),
  key_hash: text('key_hash').notNull(),
  scopes_json: text('scopes_json').notNull(),
  ip_allowlist_json: text('ip_allowlist_json'),
  rate_limit_per_min: integer('rate_limit_per_min'),
  created_at: integer('created_at').notNull(),
  last_used_at: integer('last_used_at'),
  expires_at: integer('expires_at'),
  revoked_at: integer('revoked_at'),
},

  (table) => [
    index('idx_api_keys_prefix').on(table.prefix),
  ])

export const auditLog = sqliteTable('audit_log', {
  id: integer().primaryKey({ autoIncrement: true }),
  at: integer().notNull(),
  actor_type: text('actor_type').notNull(),
  actor_id: text('actor_id'),
  action: text().notNull(),
  target: text(),
  ip: text(),
  request_id: text('request_id'),
  detail_json: text('detail_json'),
},

  (table) => [
    index('idx_audit_at').on(table.at),
  ])

export const subscriptions = sqliteTable('subscriptions', {
  id: text().primaryKey(),
  name: text().notNull(),
  url: text().notNull().unique(),
  format_hint: text('format_hint').default('auto').notNull(),
  enabled: integer().default(1).notNull(),
  interval_sec: integer('interval_sec'),
  cron: text(),
  timeout_ms: integer('timeout_ms').default(20000).notNull(),
  retries: integer().default(2).notNull(),
  retry_backoff_ms: integer('retry_backoff_ms').default(1500).notNull(),
  concurrency: integer().default(3).notNull(),
  headers_json: text('headers_json'),
  user_agent: text('user_agent'),
  sub_id_override: text('sub_id_override'),
  last_sync_at: integer('last_sync_at'),
  last_status: text('last_status').default('never').notNull(),
  last_error: text('last_error'),
  last_error_kind: text('last_error_kind'),
  etag: text(),
  last_modified: text('last_modified'),
  consecutive_failures: integer('consecutive_failures').default(0).notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  content_text: text('content_text'),
})

export const subscriptionRuns = sqliteTable('subscription_runs', {
  id: text().primaryKey(),
  subscription_id: text('subscription_id').notNull(),
  trigger: text().notNull(),
  started_at: integer('started_at').notNull(),
  finished_at: integer('finished_at'),
  status: text().notNull(),
  http_status: integer('http_status'),
  bytes: integer(),
  duration_ms: integer('duration_ms'),
  total_found: integer('total_found').default(0).notNull(),
  added: integer().default(0).notNull(),
  changed: integer().default(0).notNull(),
  removed: integer().default(0).notNull(),
  restored: integer().default(0).notNull(),
  unsupported: integer().default(0).notNull(),
  parse_errors: integer('parse_errors').default(0).notNull(),
  error_kind: text('error_kind'),
  error_msg: text('error_msg'),
  result_digest: text('result_digest'),
},

  (table) => [
    index('idx_subruns_sub').on(table.subscription_id, table.started_at),
  ])

export const subscriptionRunErrors = sqliteTable('subscription_run_errors', {
  id: integer().primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull(),
  line_no: integer('line_no'),
  raw_snippet: text('raw_snippet'),
  error_kind: text('error_kind'),
  error_msg: text('error_msg'),
})

export const nodes = sqliteTable('nodes', {
  id: text().primaryKey(),
  display_name: text('display_name').notNull(),
  country_code: text('country_code'),
  region: text(),
  protocol: text().notNull(),
  fingerprint: text().notNull().unique(),
  params_hash: text('params_hash').notNull(),
  outbound_json: text('outbound_json').notNull(),
  protocol_supported: integer('protocol_supported').default(1).notNull(),
  enabled: integer().default(1).notNull(),
  publish_policy_override: text('publish_policy_override'),
  is_virtual: integer('is_virtual').default(0).notNull(),
  check_depth: text('check_depth').default('full').notNull(),
  publish_error: text('publish_error'),
  first_seen_at: integer('first_seen_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
  missing_since: integer('missing_since'),
  stale_until: integer('stale_until'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
},

  (table) => [
    index('idx_nodes_country').on(table.country_code),
    index('idx_nodes_enabled_missing').on(table.enabled, table.missing_since),
    index('idx_nodes_protocol').on(table.protocol),
    index('idx_nodes_fingerprint').on(table.fingerprint),
  ])

export const nodeSources = sqliteTable('node_sources', {
  node_id: text('node_id').notNull(),
  subscription_id: text('subscription_id').notNull(),
  name_in_sub: text('name_in_sub'),
  first_seen_at: integer('first_seen_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
},

  (table) => [
    index('idx_node_sources_sub').on(table.subscription_id),
    primaryKey({ columns: [table.node_id, table.subscription_id], name: 'node_sources_node_id_subscription_id_pk'})
  ])

export const nodeAliases = sqliteTable('node_aliases', {
  alias: text().primaryKey(),
  node_id: text('node_id').notNull(),
  created_at: integer('created_at').notNull(),
  active: integer().default(1).notNull(),
},

  (table) => [
    index('idx_node_aliases_node').on(table.node_id),
  ])

export const nodeCredentials = sqliteTable('node_credentials', {
  node_id: text('node_id').primaryKey(),
  username: text().notNull(),
  password_enc: text('password_enc').notNull(),
  password_lookup_hash: text('password_lookup_hash').notNull(),
  created_at: integer('created_at').notNull(),
  rotated_at: integer('rotated_at'),
},

  (table) => [
    index('idx_node_cred_lookup').on(table.password_lookup_hash),
  ])

export const nodePort = sqliteTable('node_port', {
  node_id: text('node_id').primaryKey(),
  port: integer().notNull().unique(),
  assigned_at: integer('assigned_at').notNull(),
  released_at: integer('released_at'),
  reusable_at: integer('reusable_at'),
},

  (table) => [
    index('idx_node_port_port').on(table.port),
  ])

export const nodeStatus = sqliteTable('node_status', {
  node_id: text('node_id').primaryKey(),
  state: text().default('unknown').notNull(),
  last_check_at: integer('last_check_at'),
  last_ok_at: integer('last_ok_at'),
  last_fail_at: integer('last_fail_at'),
  recovered_at: integer('recovered_at'),
  connect_ms: integer('connect_ms'),
  handshake_ms: integer('handshake_ms'),
  total_ms: integer('total_ms'),
  delay_ms: integer('delay_ms'),
  exit_ip: text('exit_ip'),
  exit_country: text('exit_country'),
  exit_region: text('exit_region'),
  exit_asn: text('exit_asn'),
  exit_isp: text('exit_isp'),
  error_kind: text('error_kind'),
  error_msg: text('error_msg'),
  fail_streak: integer('fail_streak').default(0).notNull(),
  success_streak: integer('success_streak').default(0).notNull(),
  next_check_at: integer('next_check_at'),
  checks_total: integer('checks_total').default(0).notNull(),
  checks_ok: integer('checks_ok').default(0).notNull(),
  uptime_24h: real('uptime_24h').notNull().default(0),
  updated_at: integer('updated_at').notNull(),
},

  (table) => [
    index('idx_node_status_state_next').on(table.state, table.next_check_at),
  ])

export const nodeCheckRuns = sqliteTable('node_check_runs', {
  id: integer().primaryKey({ autoIncrement: true }),
  node_id: text('node_id').notNull(),
  at: integer().notNull(),
  source: text().notNull(),
  ok: integer().notNull(),
  stage_reached: text('stage_reached'),
  connect_ms: integer('connect_ms'),
  handshake_ms: integer('handshake_ms'),
  total_ms: integer('total_ms'),
  delay_ms: integer('delay_ms'),
  http_status: integer('http_status'),
  exit_ip: text('exit_ip'),
  exit_country: text('exit_country'),
  error_kind: text('error_kind'),
  error_msg: text('error_msg'),
  detail_json: text('detail_json'),
},

  (table) => [
    index('idx_check_runs_node').on(table.node_id, table.at),
  ])

export const runtimeRevisions = sqliteTable('runtime_revisions', {
  id: text().primaryKey(),
  status: text().notNull(),
  reason: text().notNull(),
  created_at: integer('created_at').notNull(),
  applied_at: integer('applied_at'),
  retired_at: integer('retired_at'),
  node_count: integer('node_count').default(0).notNull(),
  added_count: integer('added_count').default(0).notNull(),
  removed_count: integer('removed_count').default(0).notNull(),
  changed_count: integer('changed_count').default(0).notNull(),
  skipped_count: integer('skipped_count').default(0).notNull(),
  plan_digest: text('plan_digest'),
  plan_json: text('plan_json'),
  validation_json: text('validation_json'),
  dataplane_before_json: text('dataplane_before_json'),
  dataplane_after_json: text('dataplane_after_json'),
  error: text(),
},

  (table) => [
    index('idx_revisions_status').on(table.status, table.created_at),
  ])

export const revisionNodes = sqliteTable('revision_nodes', {
  revision_id: text('revision_id').notNull(),
  node_id: text('node_id').notNull(),
  username: text(),
  outbound_tag: text('outbound_tag'),
  inbound_tag: text('inbound_tag'),
  inbound_port: integer('inbound_port'),
},

  (table) => [
    primaryKey({ columns: [table.revision_id, table.node_id], name: 'revision_nodes_revision_id_node_id_pk'})
  ])

export const xrayApplyOps = sqliteTable('xray_apply_ops', {
  id: integer().primaryKey({ autoIncrement: true }),
  revision_id: text('revision_id'),
  at: integer().notNull(),
  op: text().notNull(),
  tag: text(),
  payload_json: text('payload_json'),
  ok: integer().notNull(),
  duration_ms: integer('duration_ms'),
  stdout: text(),
  stderr: text(),
  error_kind: text('error_kind'),
},

  (table) => [
    index('idx_apply_ops_op').on(table.op),
    index('idx_apply_ops_at').on(table.at),
  ])

export const dataplaneState = sqliteTable('dataplane_state', {
  id: integer().primaryKey({ autoIncrement: true }),
  at: integer().notNull(),
  source: text().notNull(),
  outbounds_json: text('outbounds_json'),
  inbounds_json: text('inbounds_json'),
  rules_json: text('rules_json'),
  digest: text(),
},

  (table) => [
    index('idx_dataplane_at').on(table.at),
  ])

export const pendingRetire = sqliteTable('pending_retire', {
  id: text().primaryKey(),
  kind: text().notNull(),
  tag: text().notNull(),
  node_id: text('node_id'),
  revision_id: text('revision_id'),
  retire_after: integer('retire_after').notNull(),
  done_at: integer('done_at'),
  error: text(),
},

  (table) => [
    index('idx_pending_retire_due').on(table.done_at, table.retire_after),
  ])

export const jobs = sqliteTable('jobs', {
  id: text().primaryKey(),
  kind: text().notNull(),
  status: text().notNull(),
  priority: integer().default(0).notNull(),
  payload_json: text('payload_json'),
  progress: integer().default(0).notNull(),
  total: integer().default(0).notNull(),
  message: text(),
  started_at: integer('started_at'),
  finished_at: integer('finished_at'),
  result_json: text('result_json'),
  error: text(),
  created_by: text('created_by'),
  created_at: integer('created_at').notNull(),
},

  (table) => [
    index('idx_jobs_status_created').on(table.status, table.created_at),
  ])

export const events = sqliteTable('events', {
  id: integer().primaryKey({ autoIncrement: true }),
  at: integer().notNull(),
  level: text().notNull(),
  kind: text().notNull(),
  node_id: text('node_id'),
  subscription_id: text('subscription_id'),
  revision_id: text('revision_id'),
  message: text().notNull(),
  detail_json: text('detail_json'),
},

  (table) => [
    index('idx_events_at').on(table.at),
  ])

export const gatewayRoutes = sqliteTable('gateway_routes', {
  id: integer().primaryKey({ autoIncrement: true }),
  updated_at: integer('updated_at').notNull(),
  table_json: text('table_json').notNull(),
  digest: text().notNull(),
})

export const nodeConnections = sqliteTable('node_connections', {
  id: integer().primaryKey(),
  node_id: text('node_id'),
  username: text(),
  client_ip: text('client_ip'),
  target: text(),
  started_at: integer('started_at').notNull(),
  closed_at: integer('closed_at'),
  up_bytes: integer('up_bytes').default(0).notNull(),
  down_bytes: integer('down_bytes').default(0).notNull(),
  close_reason: text('close_reason'),
},

  (table) => [
    index('idx_conns_node').on(table.node_id),
    index('idx_conns_started').on(table.started_at),
  ])

export const appliedNodes = sqliteTable('applied_nodes', {
  node_id: text('node_id').primaryKey(),
  outbound_tag: text('outbound_tag').notNull(),
  inbound_tag: text('inbound_tag').notNull(),
  rule_tag: text('rule_tag').notNull(),
  port: integer().notNull(),
  outbound_json: text('outbound_json').notNull(),
  content_hash: text('content_hash').notNull(),
  applied_at: integer('applied_at').notNull(),
},

  (table) => [
    index('idx_applied_outbound').on(table.outbound_tag),
  ])

/** drizzle({ client, schema }) 用的整体 schema 对象 */
export const schema = {
  schemaMigrations,
  settings,
  admin,
  sessions,
  apiKeys,
  auditLog,
  subscriptions,
  subscriptionRuns,
  subscriptionRunErrors,
  nodes,
  nodeSources,
  nodeAliases,
  nodeCredentials,
  nodePort,
  nodeStatus,
  nodeCheckRuns,
  runtimeRevisions,
  revisionNodes,
  xrayApplyOps,
  dataplaneState,
  pendingRetire,
  jobs,
  events,
  gatewayRoutes,
  nodeConnections,
  appliedNodes,
} as const

export type Tables = typeof schema
