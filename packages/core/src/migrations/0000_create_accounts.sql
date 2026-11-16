CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'revenue', 'expense');--> statement-breakpoint
CREATE TABLE "accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "account_type" NOT NULL,
	"allow_overdraft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
