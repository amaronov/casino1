// @ts-nocheck
// Supabase Edge Function entry point. SUPABASE_DB_URL is provided by Supabase automatically.
import postgres from 'npm:postgres@3.4.5';
import { createApp } from './app.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), {
  prepare: false, // required by Supabase's transaction pooler
  max: 3,
});

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || 'https://amaronov.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

Deno.serve(createApp({ sql, allowedOrigins }));
