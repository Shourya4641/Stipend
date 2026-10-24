-- updated_at, maintained by the database.
--
-- Hand-written: Drizzle's schema builder cannot express a trigger.
--
-- A trigger rather than setting it in ledger.ts, because this table is the
-- audit record we point at on camera and a timestamp that is SOMETIMES
-- right is worse than none. The application version is one forgotten UPDATE
-- away from lying, and it cannot cover raw SQL run against the table at all.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER settlements_set_updated_at
  BEFORE UPDATE ON settlements
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
