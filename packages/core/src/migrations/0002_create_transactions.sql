CREATE TYPE "public"."transaction_kind" AS ENUM('capture', 'refund', 'transfer');--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"payment_id" uuid,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idempotency_key_idempotency_records_key_fk" FOREIGN KEY ("idempotency_key") REFERENCES "public"."idempotency_records"("key") ON DELETE no action ON UPDATE no action;