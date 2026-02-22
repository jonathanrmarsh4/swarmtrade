-- Adds the summary column to sentiment_cache.
-- The Crowd Thermometer's LLM call (buildCrowdThermometerPrompt) generates this
-- narrative and stores it alongside the raw score data. The Sentiment Agent
-- index.js reads it back at deliberation time via getSentimentSnapshot().
ALTER TABLE sentiment_cache ADD COLUMN IF NOT EXISTS summary TEXT;
