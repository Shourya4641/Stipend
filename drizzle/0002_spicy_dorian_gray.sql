DROP INDEX "settlements_signature_uq";--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "tx_signature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "message_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_message_hash_uq" ON "settlements" USING btree ("network","message_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_signature_uq" ON "settlements" USING btree ("network","tx_signature") WHERE "settlements"."tx_signature" is not null;