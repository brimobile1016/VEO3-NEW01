// routes/supabase.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL="https://nhjbbesruvuwsvdhhbkn.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5oamJiZXNydXZ1d3N2ZGhoYmtuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NzY4MTEyMywiZXhwIjoyMDczMjU3MTIzfQ.YZJ3f5qnFA2umF4Kj5TJZ2vaJbjbEhgRboZuNZ8Try8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
