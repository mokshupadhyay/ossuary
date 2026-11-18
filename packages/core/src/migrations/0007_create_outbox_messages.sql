CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'dead');--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token" uuid,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_event_id_webhook_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox_messages" USING btree ("status","next_attempt_at");