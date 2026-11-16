CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" uuid PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_key_idx" ON "idempotency_records" USING btree ("key");