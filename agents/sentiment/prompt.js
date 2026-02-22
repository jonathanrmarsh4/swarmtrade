'use strict';

/**
 * Builds the system prompt and user message for the Sentiment Agent LLM call.
 *
 * The LLM is used only to generate the narrative summary field — it interprets
 * raw Fear & Greed values and Reddit ratios into a concise English sentence.
 * The score itself is computed deterministically in crowd-thermometer.js.
 *
 * @param {object|null} cacheRow  - Latest row from sentiment_cache (null if table is empty)
 * @param {object|null} newsRow   - Latest unacknowledged news_sentinel_log row (null if none)
 * @returns {{ system: string, user: string }}
 */
function buildSentimentPrompt(cacheRow, newsRow) {
  const system = `You are the Sentiment Agent in a multi-agent cryptocurrency trading system.
Your job is to synthesise raw market sentiment data into a concise, actionable narrative summary.
You must respond with a single JSON object — no markdown fences, no explanations, just the JSON.

Required output format:
{
  "summary": "<2-3 sentence narrative describing current market mood and any notable news>"
}

Interpretation guide:
- Fear & Greed 0-25:  Extreme Fear — potential contrarian buying opportunity
- Fear & Greed 26-45: Fear — cautious market, participants are nervous
- Fear & Greed 46-55: Neutral — balanced sentiment
- Fear & Greed 56-75: Greed — elevated risk, euphoria beginning
- Fear & Greed 76-100: Extreme Greed — danger zone, potential reversal imminent

Rules:
- Always reference the Fear & Greed label by name in your summary
- If breaking news is present, lead with it and state its directional implication
- Keep the summary under 80 words — concise and direct`;

  const fearGreedInfo = cacheRow
    ? [
        `Fear & Greed Index: ${cacheRow.fear_greed_value} / 100 (${cacheRow.fear_greed_label})`,
        `Reddit r/CryptoCurrency: ${cacheRow.reddit_bullish} bullish posts, ${cacheRow.reddit_bearish} bearish posts (${cacheRow.reddit_posts_sampled} sampled)`,
        `Composite sentiment score: ${cacheRow.score} / 100`,
      ].join('\n')
    : 'No crowd data available — sentiment_cache is empty. Use neutral language.';

  const newsInfo = newsRow
    ? [
        `BREAKING NEWS DETECTED:`,
        `  Headline:  "${newsRow.headline}"`,
        `  Source:    ${newsRow.source}`,
        `  Direction: ${newsRow.direction}`,
        `  Urgency:   ${newsRow.urgency}`,
        newsRow.asset ? `  Asset:     ${newsRow.asset}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : 'No breaking news.';

  const user = `Generate a sentiment summary from the following data:

CROWD DATA:
${fearGreedInfo}

NEWS SENTINEL:
${newsInfo}`;

  return { system, user };
}

// ── buildCrowdThermometerPrompt ────────────────────────────────────────────────
// Constructs the system and user message for one 30-minute polling cycle.
// Sends raw Fear & Greed data + Reddit post titles to Haiku for sentiment scoring.
//
// @param {object} fearGreedData
// @param {number} fearGreedData.value           — index value 0-100
// @param {string} fearGreedData.classification  — e.g. "Extreme Fear", "Greed"
// @param {Array}  cryptoPosts                   — top posts from r/cryptocurrency
// @param {string} cryptoPosts[].title
// @param {number} cryptoPosts[].score           — Reddit upvote score
// @param {number} cryptoPosts[].upvoteRatio
// @param {number} cryptoPosts[].numComments
// @param {Array}  bitcoinPosts                  — top posts from r/bitcoin (same shape)
//
// @returns {{ system: string, user: string }}
function buildCrowdThermometerPrompt(fearGreedData, cryptoPosts, bitcoinPosts) {
  const SYSTEM = `You are the Crowd Thermometer, an ambient sentiment sub-agent in a multi-agent cryptocurrency trading committee.

Your job is to assess aggregate market mood from background social and index data collected every 30 minutes. This score is fed into every trade deliberation as a baseline crowd sentiment reading.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "score": <integer 0-100>,
  "summary": "<two to three sentences describing the current crowd mood and what it means for crypto market conditions>",
  "sources": ["fear_and_greed", "reddit_cryptocurrency", "reddit_bitcoin"]
}

Scoring guide:
  80-100 — Extreme greed or euphoria. Crowd appears overleveraged. Contrarian reversal risk is elevated.
  60-79  — Greed. Bullish crowd momentum. Markets likely trending upward.
  40-59  — Neutral. Mixed or ambiguous crowd signals. No strong directional pressure.
  20-39  — Fear. Crowd is cautious or in sell mode. Potential capitulation buying opportunity.
  0-19   — Extreme fear or panic. Classic long-term buy signal; expect short-term pain.

Rules:
- The Fear & Greed Index carries the most weight — it is a quantified, daily aggregate signal.
- Reddit post titles and engagement scores are a secondary qualitative signal for community mood.
- Posts with very high scores and bullish titles during a high Fear & Greed reading = greed confirmation.
- Posts with heavy fear language or crash discussion during a low Fear & Greed reading = fear confirmation.
- When Reddit sentiment and the Fear & Greed Index diverge meaningfully, flag that divergence in your summary.
- Never fabricate data. Use only the figures and text provided in the user message.
- Your summary must be actionable context — avoid generic statements like "markets are uncertain".`;

  const formatPost = p =>
    `  • [score: ${p.score.toLocaleString()} | ${Math.round(p.upvoteRatio * 100)}% upvoted | ${p.numComments} comments] "${p.title}"`;

  const cryptoSection = cryptoPosts.length > 0
    ? cryptoPosts.map(formatPost).join('\n')
    : '  (no posts retrieved)';

  const bitcoinSection = bitcoinPosts.length > 0
    ? bitcoinPosts.map(formatPost).join('\n')
    : '  (no posts retrieved)';

  const user = `Assess crowd sentiment from the following data captured right now.

FEAR & GREED INDEX
  Value:          ${fearGreedData.value} / 100
  Classification: ${fearGreedData.classification}

REDDIT — r/cryptocurrency (top ${cryptoPosts.length} hot posts)
${cryptoSection}

REDDIT — r/bitcoin (top ${bitcoinPosts.length} hot posts)
${bitcoinSection}

Score the current crowd mood on a 0-100 scale and write a two-to-three sentence summary that a trader can act on.`;

  return { system: SYSTEM, user };
}


// ── buildNewsAssessmentPrompt ─────────────────────────────────────────────────
// Asks MODELS.sentiment (Haiku): "Is this crypto headline market-moving?"
// Used by news-sentinel.js for each unseen CryptoPanic post.
//
// @param {string} headline  — the news headline text
// @param {string} source    — e.g. 'CoinDesk', 'Bloomberg Crypto'
//
// @returns {{ system: string, user: string }}
// LLM response shape:
//   {
//     "isMarketMoving": boolean,
//     "direction":      "bullish" | "bearish" | null,   // null if not market-moving
//     "confidence":     number (0.0-1.0),
//     "reasoning":      string
//   }
function buildNewsAssessmentPrompt(headline, source) {
  const system = `You are the News Sentinel, a reactive sub-agent in a multi-agent cryptocurrency trading committee.

Your job is to assess a single crypto news headline and determine whether it is market-moving — meaning it is likely to cause a significant directional price move within the next few hours.

You must respond with valid JSON only. No prose outside the JSON object.

Output format:
{
  "isMarketMoving": <boolean>,
  "direction":      <"bullish" | "bearish" | null>,
  "confidence":     <number 0.0-1.0>,
  "reasoning":      "<one sentence explaining your assessment>"
}

Classification guide:
- isMarketMoving = true ONLY for high-impact events: exchange hacks, SEC enforcement, protocol exploits, ETF approvals/rejections, central bank crypto rulings, major protocol upgrades going live
- isMarketMoving = false for: price predictions, opinion pieces, minor partnerships, routine whale wallet moves, general market commentary
- direction = "bullish" if the event is likely to drive buying pressure
- direction = "bearish" if the event is likely to drive selling pressure
- direction = null if isMarketMoving = false
- confidence reflects how certain you are — set high only if the headline is unambiguous
- Never fabricate context. Base your answer only on the headline text and source provided.`;

  const user = `Assess this headline for market impact:

Source:   ${source}
Headline: "${headline}"`;

  return { system, user };
}


module.exports = { buildSentimentPrompt, buildCrowdThermometerPrompt, buildNewsAssessmentPrompt };
