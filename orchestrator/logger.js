// Logger — writes every deliberation round to Supabase.
// Called after each round to persist agent outputs before the next round begins.
// Finalises the complete deliberation record once the Risk Agent has responded.
// No deliberation state is held in memory — Supabase is the single source of truth.
