CREATE TABLE "settlements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settlements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" text,
	"request_fingerprint" text NOT NULL,
	"resource_url" text,
	"payer" text NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"pay_to" text NOT NULL,
	"amount" numeric(39, 0) NOT NULL,
	"tx_signature" text NOT NULL,
	"signed_tx" text,
	"last_valid_block_height" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"chain_slot" bigint,
	"chain_error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "settlements_state_check" CHECK ("settlements"."state" in ('rejected', 'expired', 'pending', 'confirmed', 'failed')),
	CONSTRAINT "settlements_amount_unsigned" CHECK ("settlements"."amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_signature_uq" ON "settlements" USING btree ("network","tx_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_payment_id_uq" ON "settlements" USING btree ("payer","payment_id") WHERE "settlements"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "settlements_pending_idx" ON "settlements" USING btree ("created_at") WHERE "settlements"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "settlements_payer_time_idx" ON "settlements" USING btree ("payer","created_at");--> statement-breakpoint
CREATE INDEX "settlements_created_at_idx" ON "settlements" USING btree ("created_at");