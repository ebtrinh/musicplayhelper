// src/lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

export const supabase = createClient("https://lcpdqaacsdldmxjbavkj.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjcGRxYWFjc2RsZG14amJhdmtqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ3OTA1MzYsImV4cCI6MjA3MDM2NjUzNn0.4XeNR0gABwzniL_9JdEThLndPRlxxeQ5EInLhLyzahk");
