CREATE OR REPLACE FUNCTION entries_no_mutate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'entries are append-only: % on entries is forbidden', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_no_mutate();
--> statement-breakpoint
CREATE TRIGGER entries_append_only_truncate
  BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION entries_no_mutate();
