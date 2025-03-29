-- Create RPC functions to bypass RLS for admin operations in Stripe webhooks

-- Function to find a user by email
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

-- Function to check if a user exists by ID
CREATE OR REPLACE FUNCTION public.check_user_exists(user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_exists BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.users
    WHERE id = user_id
  ) INTO user_exists;
  
  RETURN user_exists;
END;
$$;

-- Function to get first 10 users (for debugging)
CREATE OR REPLACE FUNCTION public.get_first_ten_users()
RETURNS SETOF public.users
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM public.users
  LIMIT 10;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION public.find_user_by_email IS 'Gets a user ID by email - bypasses RLS for webhook operations';
COMMENT ON FUNCTION public.check_user_exists IS 'Checks if a user with given ID exists - bypasses RLS for webhook operations';
COMMENT ON FUNCTION public.get_first_ten_users IS 'Gets first 10 users for debugging - bypasses RLS for webhook operations'; 