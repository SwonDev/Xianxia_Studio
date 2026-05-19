-- v0.5.0 — long-form chapters: outline + per-chapter resumable state.
-- NEW migration; never edit 0001/0002 (sqlx records their hash).
CREATE TABLE IF NOT EXISTS script_outline (
    project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    outline_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_state (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_index  INTEGER NOT NULL,
    title          TEXT NOT NULL,
    status         TEXT NOT NULL,            -- pending|writing|done|failed
    narration_path TEXT,
    summary_text   TEXT,
    words          INTEGER,
    error_message  TEXT,
    updated_at     INTEGER NOT NULL,
    UNIQUE(project_id, chapter_index)
);

CREATE INDEX IF NOT EXISTS idx_chapter_state_project
    ON chapter_state(project_id, chapter_index);
