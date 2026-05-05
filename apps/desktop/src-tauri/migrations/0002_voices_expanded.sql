-- Migration: re-seed voice_profiles with the full Qwen3-TTS catalog.
-- Idempotent: only inserts rows that don't exist (preset-* IDs are stable).
INSERT OR IGNORE INTO voice_profiles (id, name, language, kind, description, is_default) VALUES
    ('preset-aiden-en',    'Aiden',    'en', 'preset', 'Male narrator, mellow storyteller',  0),
    ('preset-ryan-en',     'Ryan',     'en', 'preset', 'Male narrator, theatrical',          0),
    ('preset-serena-es',   'Serena',   'es', 'preset', 'Female narrator, soft',              0),
    ('preset-eric-es',     'Eric',     'es', 'preset', 'Male narrator, deep',                0),
    ('preset-aiden-es',    'Aiden',    'es', 'preset', 'Male narrator, warm',                0),
    ('preset-eric-zh',     'Eric',     'zh', 'preset', 'Male narrator, deep',                0),
    ('preset-ono-anna-ja', 'Ono Anna', 'ja', 'preset', 'Female narrator, native Japanese',   1),
    ('preset-vivian-ja',   'Vivian',   'ja', 'preset', 'Female narrator, multilingual',      0),
    ('preset-sohee-ko',    'Sohee',    'ko', 'preset', 'Female narrator, native Korean',     1),
    ('preset-vivian-ko',   'Vivian',   'ko', 'preset', 'Female narrator, multilingual',      0),
    ('preset-serena-de',   'Serena',   'de', 'preset', 'Female narrator, clear',             1),
    ('preset-eric-de',     'Eric',     'de', 'preset', 'Male narrator, deep',                0),
    ('preset-vivian-fr',   'Vivian',   'fr', 'preset', 'Female narrator',                    1),
    ('preset-aiden-fr',    'Aiden',    'fr', 'preset', 'Male narrator',                      0),
    ('preset-vivian-it',   'Vivian',   'it', 'preset', 'Female narrator',                    1),
    ('preset-eric-it',     'Eric',     'it', 'preset', 'Male narrator',                      0),
    ('preset-vivian-pt',   'Vivian',   'pt', 'preset', 'Female narrator',                    1),
    ('preset-aiden-pt',    'Aiden',    'pt', 'preset', 'Male narrator',                      0),
    ('preset-vivian-ru',   'Vivian',   'ru', 'preset', 'Female narrator',                    1),
    ('preset-eric-ru',     'Eric',     'ru', 'preset', 'Male narrator',                      0);
