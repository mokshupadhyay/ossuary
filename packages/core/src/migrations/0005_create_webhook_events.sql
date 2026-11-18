CREATE TYPE "public"."webhook_event_status" AS ENUM('applied', 'parked', 'ignored', 'rejected');--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "webhook_events_received_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" bigint,
	"asset" text NOT NULL,
	"raw_body" text NOT NULL,
	"status" "webhook_event_status" NOT NULL,
	"rejection_reason" text,
	"ledger_transaction_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "webhook_events_received_seq_unique" UNIQUE("received_seq")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_ledger_transaction_id_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_parked_idx" ON "webhook_events" USING btree ("payment_id","received_seq") WHERE status = 'parked';