-- Xianxia Studio — initial schema (PLAN.md §4)

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    variant TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT,
    downloaded_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    topic TEXT NOT NULL,
    status TEXT NOT NULL,
    languages TEXT NOT NULL,
    duration_seconds REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_steps (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    progress REAL DEFAULT 0,
    output_json TEXT,
    error_message TEXT,
    UNIQUE(project_id, phase)
);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    language TEXT,
    path TEXT NOT NULL,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS script_markers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    timestamp_seconds REAL,
    prompt TEXT,
    mood TEXT,
    image_asset_id TEXT REFERENCES assets(id),
    music_asset_id TEXT REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS scheduled_uploads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    youtube_video_id TEXT,
    scheduled_at INTEGER NOT NULL,
    privacy_status TEXT NOT NULL,
    publish_at INTEGER,
    is_short INTEGER NOT NULL DEFAULT 0,
    parent_upload_id TEXT REFERENCES scheduled_uploads(id),
    status TEXT NOT NULL,
    last_attempt_at INTEGER,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS youtube_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    encrypted_blob BLOB NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    kind TEXT NOT NULL,
    reference_audio_path TEXT,
    embedding_path TEXT,
    description TEXT,
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trending_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL,
    region TEXT,
    fetched_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    component TEXT NOT NULL,
    project_id TEXT,
    message TEXT NOT NULL,
    payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_project ON pipeline_steps(project_id, phase);
CREATE INDEX IF NOT EXISTS idx_assets_project_kind ON assets(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_uploads(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

-- Seed default voice profiles for Qwen3-TTS
INSERT OR IGNORE INTO voice_profiles (id, name, language, kind, description, is_default) VALUES
    ('preset-vivian-en',    'Vivian',    'en', 'preset', 'Female narrator, warm', 1),
    ('preset-serena-en',    'Serena',    'en', 'preset', 'Female narrator, calm', 0),
    ('preset-eric-en',      'Eric',      'en', 'preset', 'Male narrator, deep',   0),
    ('preset-dylan-en',     'Dylan',     'en', 'preset', 'Male narrator, bright', 0),
    ('preset-vivian-zh',    'Vivian',    'zh', 'preset', 'Female narrator, warm', 1),
    ('preset-uncle-fu-zh',  'Uncle Fu',  'zh', 'preset', 'Elder male, sage tone', 0),
    ('preset-vivian-es',    'Vivian',    'es', 'preset', 'Female narrator, warm', 1);
