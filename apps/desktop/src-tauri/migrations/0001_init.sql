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

-- Seed Qwen3-TTS voice catalog: 9 preset voices × 10 supported languages
-- (Chinese, English, Japanese, Korean, German, French, Russian, Portuguese,
--  Spanish, Italian). Each voice carries the same speaker timbre across
-- languages thanks to Qwen3-TTS multilingual training; we mark the
-- linguistically-strongest voice per language as default.
INSERT OR IGNORE INTO voice_profiles (id, name, language, kind, description, is_default) VALUES
    -- English
    ('preset-vivian-en',     'Vivian',     'en', 'preset', 'Female narrator, warm cinematic', 1),
    ('preset-serena-en',     'Serena',     'en', 'preset', 'Female narrator, calm meditative', 0),
    ('preset-eric-en',       'Eric',       'en', 'preset', 'Male narrator, deep authoritative', 0),
    ('preset-dylan-en',      'Dylan',      'en', 'preset', 'Male narrator, bright youthful', 0),
    ('preset-aiden-en',      'Aiden',      'en', 'preset', 'Male narrator, mellow storyteller', 0),
    ('preset-ryan-en',       'Ryan',       'en', 'preset', 'Male narrator, theatrical', 0),
    -- Spanish
    ('preset-vivian-es',     'Vivian',     'es', 'preset', 'Female narrator, multilingual', 1),
    ('preset-serena-es',     'Serena',     'es', 'preset', 'Female narrator, soft', 0),
    ('preset-eric-es',       'Eric',       'es', 'preset', 'Male narrator, deep', 0),
    ('preset-aiden-es',      'Aiden',      'es', 'preset', 'Male narrator, warm', 0),
    -- Chinese (Mandarin)
    ('preset-vivian-zh',     'Vivian',     'zh', 'preset', 'Female narrator, multilingual',   0),
    ('preset-uncle-fu-zh',   'Uncle Fu',   'zh', 'preset', 'Elder male, native Mandarin sage', 1),
    ('preset-eric-zh',       'Eric',       'zh', 'preset', 'Male narrator, deep',              0),
    -- Japanese
    ('preset-ono-anna-ja',   'Ono Anna',   'ja', 'preset', 'Female narrator, native Japanese', 1),
    ('preset-vivian-ja',     'Vivian',     'ja', 'preset', 'Female narrator, multilingual',    0),
    -- Korean
    ('preset-sohee-ko',      'Sohee',      'ko', 'preset', 'Female narrator, native Korean',   1),
    ('preset-vivian-ko',     'Vivian',     'ko', 'preset', 'Female narrator, multilingual',    0),
    -- German
    ('preset-serena-de',     'Serena',     'de', 'preset', 'Female narrator, clear',          1),
    ('preset-eric-de',       'Eric',       'de', 'preset', 'Male narrator, deep',             0),
    -- French
    ('preset-vivian-fr',     'Vivian',     'fr', 'preset', 'Female narrator',                 1),
    ('preset-aiden-fr',      'Aiden',      'fr', 'preset', 'Male narrator',                   0),
    -- Italian
    ('preset-vivian-it',     'Vivian',     'it', 'preset', 'Female narrator',                 1),
    ('preset-eric-it',       'Eric',       'it', 'preset', 'Male narrator',                   0),
    -- Portuguese
    ('preset-vivian-pt',     'Vivian',     'pt', 'preset', 'Female narrator',                 1),
    ('preset-aiden-pt',      'Aiden',      'pt', 'preset', 'Male narrator',                   0),
    -- Russian
    ('preset-vivian-ru',     'Vivian',     'ru', 'preset', 'Female narrator',                 1),
    ('preset-eric-ru',       'Eric',       'ru', 'preset', 'Male narrator',                   0);
