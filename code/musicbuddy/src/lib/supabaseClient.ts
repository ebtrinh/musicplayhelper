import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public'; // dynamic avoids build-time export issues

const url = env.PUBLIC_SUPABASE_URL;
const key = env.PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) console.error('Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY');

export const supabase = createClient(url!, key!);


