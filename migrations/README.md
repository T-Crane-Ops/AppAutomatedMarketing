# Database Migrations

This directory contains SQL migrations for the Supabase database.

## 20250329_add_webhook_rpc_functions.sql

This migration adds RPC functions needed for Stripe webhook operations to bypass Row Level Security (RLS).

### Issue Fixed

The Stripe webhook was failing with `permission denied for schema public` errors because the webhook couldn't access user data due to RLS policies.

### Solution

Created SECURITY DEFINER functions that run with the definer's permissions (typically the database owner), allowing the webhook to:
- Find users by email
- Check if users exist by ID
- Get users for debugging

### How to Apply

Run this migration against your Supabase database using one of these methods:

1. **Supabase Dashboard**:
   - Go to the Supabase project dashboard
   - Navigate to SQL Editor
   - Copy and paste the SQL from `20250329_add_webhook_rpc_functions.sql`
   - Run the query

2. **Supabase CLI**:
   ```bash
   supabase db push migrations/20250329_add_webhook_rpc_functions.sql
   ```

3. **psql**:
   ```bash
   psql "postgres://postgres:[YOUR-PASSWORD]@[YOUR-PROJECT-REF].supabase.co:5432/postgres" -f migrations/20250329_add_webhook_rpc_functions.sql
   ```

After applying the migration, the Stripe webhook should be able to process events properly even with RLS enabled. 