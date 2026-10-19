ALTER TABLE execution_steps ADD COLUMN effect_key text;
CREATE UNIQUE INDEX unique_step_effect ON execution_steps(effect_key) WHERE effect_key IS NOT NULL AND state IN ('waiting','running','completed');
