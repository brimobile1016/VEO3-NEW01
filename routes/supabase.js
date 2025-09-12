import { createClient } from "@supabase/supabase-js";

// 🔑 Ambil dari environment variable
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ✅ Client dengan service role (hanya untuk server-side)
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
