import { sql } from 'drizzle-orm'
import type { Db } from './db'
import { logger } from './log'
import { schemaMigrations } from './schema'
import { DRIZZLE_MIGRATIONS } from './migrations.generated'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** PANEL.md §6 的数据模型，逐表落地。 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  ip_allowlist_json TEXT,
  rate_limit_per_min INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  request_id TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- §6.2 订阅
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  format_hint TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_sec INTEGER,
  cron TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 20000,
  retries INTEGER NOT NULL DEFAULT 2,
  retry_backoff_ms INTEGER NOT NULL DEFAULT 1500,
  concurrency INTEGER NOT NULL DEFAULT 3,
  headers_json TEXT,
  user_agent TEXT,
  sub_id_override TEXT,
  last_sync_at INTEGER,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  last_error_kind TEXT,
  etag TEXT,
  last_modified TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_runs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  http_status INTEGER,
  bytes INTEGER,
  duration_ms INTEGER,
  total_found INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0,
  unsupported INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT,
  error_msg TEXT,
  result_digest TEXT
);
CREATE INDEX IF NOT EXISTS idx_subruns_sub ON subscription_runs(subscription_id, started_at DESC);

CREATE TABLE IF NOT EXISTS subscription_run_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  line_no INTEGER,
  raw_snippet TEXT,
  error_kind TEXT,
  error_msg TEXT
);

-- §6.3 节点（期望状态）
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  country_code TEXT,
  region TEXT,
  protocol TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  params_hash TEXT NOT NULL,
  outbound_json TEXT NOT NULL,
  protocol_supported INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  publish_policy_override TEXT,
  is_virtual INTEGER NOT NULL DEFAULT 0,
  check_depth TEXT NOT NULL DEFAULT 'full',
  publish_error TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_since INTEGER,
  stale_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint);
CREATE INDEX IF NOT EXISTS idx_nodes_protocol ON nodes(protocol);
CREATE INDEX IF NOT EXISTS idx_nodes_enabled_missing ON nodes(enabled, missing_since);
CREATE INDEX IF NOT EXISTS idx_nodes_country ON nodes(country_code);

CREATE TABLE IF NOT EXISTS node_sources (
  node_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  name_in_sub TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_node_sources_sub ON node_sources(subscription_id);

CREATE TABLE IF NOT EXISTS node_aliases (
  alias TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_node_aliases_node ON node_aliases(node_id);

CREATE TABLE IF NOT EXISTS node_credentials (
  node_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  password_lookup_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_node_cred_lookup ON node_credentials(password_lookup_hash);

CREATE TABLE IF NOT EXISTS node_port (
  node_id TEXT PRIMARY KEY,
  port INTEGER NOT NULL UNIQUE,
  assigned_at INTEGER NOT NULL,
  released_at INTEGER,
  reusable_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_node_port_port ON node_port(port);

-- §6.4 检测结果
CREATE TABLE IF NOT EXISTS node_status (
  node_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'unknown',
  last_check_at INTEGER,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  recovered_at INTEGER,
  connect_ms INTEGER,
  handshake_ms INTEGER,
  total_ms INTEGER,
  delay_ms INTEGER,
  exit_ip TEXT,
  exit_country TEXT,
  exit_region TEXT,
  exit_asn TEXT,
  exit_isp TEXT,
  error_kind TEXT,
  error_msg TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER,
  checks_total INTEGER NOT NULL DEFAULT 0,
  checks_ok INTEGER NOT NULL DEFAULT 0,
  uptime_24h REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_status_state_next ON node_status(state, next_check_at);

CREATE TABLE IF NOT EXISTS node_check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL,
  stage_reached TEXT,
  connect_ms INTEGER,
  handshake_ms INTEGER,
  total_ms INTEGER,
  delay_ms INTEGER,
  http_status INTEGER,
  exit_ip TEXT,
  exit_country TEXT,
  error_kind TEXT,
  error_msg TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_check_runs_node ON node_check_runs(node_id, at DESC);

-- §6.5 运行版本与数据面对账
CREATE TABLE IF NOT EXISTS runtime_revisions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  retired_at INTEGER,
  node_count INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  plan_digest TEXT,
  plan_json TEXT,
  validation_json TEXT,
  dataplane_before_json TEXT,
  dataplane_after_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_status ON runtime_revisions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS revision_nodes (
  revision_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  username TEXT,
  outbound_tag TEXT,
  inbound_tag TEXT,
  inbound_port INTEGER,
  PRIMARY KEY (revision_id, node_id)
);

CREATE TABLE IF NOT EXISTS xray_apply_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT,
  at INTEGER NOT NULL,
  op TEXT NOT NULL,
  tag TEXT,
  payload_json TEXT,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  stdout TEXT,
  stderr TEXT,
  error_kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_apply_ops_at ON xray_apply_ops(at DESC);
CREATE INDEX IF NOT EXISTS idx_apply_ops_op ON xray_apply_ops(op);

CREATE TABLE IF NOT EXISTS dataplane_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  outbounds_json TEXT,
  inbounds_json TEXT,
  rules_json TEXT,
  digest TEXT
);
CREATE INDEX IF NOT EXISTS idx_dataplane_at ON dataplane_state(at DESC);

CREATE TABLE IF NOT EXISTS pending_retire (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tag TEXT NOT NULL,
  node_id TEXT,
  revision_id TEXT,
  retire_after INTEGER NOT NULL,
  done_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_retire_due ON pending_retire(done_at, retire_after);

-- §6.6 任务、事件与连接
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  result_json TEXT,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  subscription_id TEXT,
  revision_id TEXT,
  message TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);

CREATE TABLE IF NOT EXISTS gateway_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  updated_at INTEGER NOT NULL,
  table_json TEXT NOT NULL,
  digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_connections (
  id INTEGER PRIMARY KEY,
  node_id TEXT,
  username TEXT,
  client_ip TEXT,
  target TEXT,
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  up_bytes INTEGER NOT NULL DEFAULT 0,
  down_bytes INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_conns_started ON node_connections(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_conns_node ON node_connections(node_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'applied-nodes',
    sql: `
-- 控制面对「数据面实际生效了什么」的信念（PANEL.md §9.1 步骤 4 的 actual 来源之一）。
-- 由于 lsrules 在部分构建中不可用，用已成功执行的 apply 操作维护这份信念，再与 lso/lsi 复核。
CREATE TABLE IF NOT EXISTS applied_nodes (
  node_id TEXT PRIMARY KEY,
  outbound_tag TEXT NOT NULL,
  inbound_tag TEXT NOT NULL,
  rule_tag TEXT NOT NULL,
  port INTEGER NOT NULL,
  outbound_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applied_outbound ON applied_nodes(outbound_tag);
`,
  },
  {
    version: 3,
    name: 'subscription-inline-text',
    sql: `
-- 面板支持「新建订阅 = URL 或粘贴文本」（PANEL.md §11.1 / §12.2）
ALTER TABLE subscriptions ADD COLUMN content_text TEXT;
`,
  },
]

/** v1-v3 是手写历史迁移，已上线，永不回改；v4+ 来自 drizzle-kit（见 migrations.generated.ts）。 */
const ALL_MIGRATIONS: Migration[] = [...MIGRATIONS, ...DRIZZLE_MIGRATIONS]

export function runMigrations(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);`)
  const done = new Set(
    db.select({ version: schemaMigrations.version }).from(schemaMigrations).all().map((r) => r.version)
  )
  let applied = 0
  for (const m of ALL_MIGRATIONS) {
    if (done.has(m.version)) continue
    // 必须走 exec：drizzle 的 run() 底层是 prepare()，多语句只会执行第一条，
    // 而一个迁移里通常有几十条 DDL（v1 就有 26 张表）。
    db.raw.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.insert(schemaMigrations).values({ version: m.version, name: m.name, applied_at: Date.now() }).run()
      db.raw.exec('COMMIT')
    } catch (e) {
      db.raw.exec('ROLLBACK')
      throw e
    }
    applied++
    logger.info(`migration applied: ${m.version} ${m.name}`)
  }
  return applied
}

export function schemaVersion(db: Db): number {
  const row = db
    .select({ v: sql<number | null>`max(${schemaMigrations.version})` })
    .from(schemaMigrations)
    .get()
  return row?.v ?? 0
}
