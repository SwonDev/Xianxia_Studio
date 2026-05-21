-- v0.10.0 — Originality Engine: protege a usuarios de la ola de
-- terminaciones de canales AI en YouTube (enero 2026) + EU AI Act
-- enforcement (2 agosto 2026).
--
-- El motor detecta cuando un script repite estructuralmente vídeos
-- previos del mismo canal, exige aportación humana mínima (thesis +
-- elección de hook + edit de outline) y guarda un "Originality
-- Manifest" auditable como prueba de aportación humana.
--
-- Schema:
--   originality_audits — 1 fila por proyecto. Score de similitud
--     estructural contra los N proyectos previos, manifest JSON con
--     sources y human_input, timestamp.
--
-- Diseño idempotente (CREATE TABLE IF NOT EXISTS): el auto-heal de
-- v0.1.12 re-aplica migraciones desde 0001, este file no falla en
-- ningún caso.

CREATE TABLE IF NOT EXISTS originality_audits (
    -- 1 audit por proyecto. Cuando se vuelva a auditar (al regenerar
    -- el script tras edits) se hace UPDATE en su lugar.
    project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,

    -- Score 0.0-1.0 (1.0 = idéntico al previo más cercano del canal).
    -- > 0.75 → warning, > 0.90 → blocking (rejection del render hasta
    -- que el usuario edite). Threshold ajustable en settings (v0.10.1).
    similarity_score REAL NOT NULL DEFAULT 0.0,

    -- Etiqueta del estado del audit:
    --   pending   — calculado pero el usuario no ha hecho human_input
    --   approved  — usuario aportó thesis/hook/edit y pasa el gate
    --   rejected  — similarity > blocking_threshold y human_input
    --               insuficiente; el pipeline NO continúa
    audit_status    TEXT NOT NULL DEFAULT 'pending',

    -- JSON con el Originality Manifest: sources extraídas del RAG,
    -- thesis personal del usuario, hooks alternativos generados, hook
    -- elegido, edits manuales al outline. Adjuntable al upload YT
    -- como prueba auditable. Schema en doc/originality-manifest.md.
    manifest_json   TEXT NOT NULL DEFAULT '{}',

    -- Cuál es el proyecto previo más similar (para diagnóstico UI).
    -- NULL si es el primer vídeo del canal.
    most_similar_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_originality_audits_status
    ON originality_audits(audit_status);
