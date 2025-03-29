# Supabase Service Role Permissions Guide

This guide explains how to correctly configure Supabase service role permissions for webhooks and server-side operations.

## Recent Changes

We encountered permission issues with the Stripe webhook handler, which was failing with:
```
permission denied for schema public
```

This was fixed by properly configuring the Supabase admin client with the service role in `utils/supabase-admin.ts`:
```ts
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    db: {
      schema: 'public'
    },
    global: {
      headers: {
        'x-supabase-role': 'service_role'
      }
    }
  }
);
```

## Troubleshooting Supabase Permission Issues

If you encounter permission errors with server-side operations:

1. **Check supabaseAdmin initialization**: Ensure it uses the service role key (not anon key) and has the proper headers and schema configuration.

2. **Verify RLS Policies**: Ensure Row Level Security (RLS) policies allow the necessary operations for the service role.

3. **Check Migration Status**: If you've added custom RPC functions, ensure they've been migrated to your database.

4. **Validate Environment Variables**: Make sure `SUPABASE_SERVICE_ROLE_KEY` is correctly set in your environment.

## Creating RPC Functions to Bypass RLS (Alternative)

If you prefer to keep stricter RLS policies while still allowing specific admin operations, you can create SQL functions with `SECURITY DEFINER`:

```sql
CREATE OR REPLACE FUNCTION public.find_user_by_email(user_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_id UUID;
BEGIN
  SELECT id INTO user_id FROM public.users
  WHERE email ILIKE user_email
  LIMIT 1;
  
  RETURN user_id;
END;
$$;
```

See our SQL migrations in the `migrations` directory for examples.

## Security Best Practices

1. Never expose the `SUPABASE_SERVICE_ROLE_KEY` to the client. It should only be used in server environments.

2. Use the most restrictive RLS policies possible, even if you're using the service role for some operations.

3. For production, consider using Supabase Functions which run in a secure, isolated environment.

4. Monitor your database access patterns and adjust permissions as needed.

For more information, consult the [Supabase official documentation](https://supabase.com/docs/guides/auth/row-level-security). 