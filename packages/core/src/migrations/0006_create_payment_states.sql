CREATE TYPE "public"."payment_status" AS ENUM('pending', 'captured', 'refunded');--> statement-breakpoint
CREATE TABLE "payment_states" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"status" "payment_status",
	"captured_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_states" ADD CONSTRAINT "payment_states_captured_event_id_webhook_events_event_id_fk" FOREIGN KEY ("captured_event_id") REFERENCES "public"."webhook_events"("event_id") ON DELETE no action ON UPDATE no action;