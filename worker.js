// Define headers for CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Calculates current sector number locked to Australian Eastern Time (Sydney)
function getAustralianSector(ms = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const todayStr = formatter.format(new Date(ms)); // Formats as YYYY-MM-DD
  const startDate = new Date('2026-01-01T00:00:00Z');
  const currentDate = new Date(`${todayStr}T00:00:00Z`);
return Math.floor((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/api/log") {
      try {
        const body = await request.json();
        const {
          userId, baseWord, wordsPlayed, score, maxWordLength,
          sector, syslogs, sectorTotalScore, cumulativeWords
        } = body;

        // Security check for max attempts per sector
        const countCheck = await env.DB.prepare(
          `SELECT COUNT(*) as attempt_count
           FROM execute_logs
           WHERE user_id = ? AND base_word = ?`
        )
        .bind(userId, baseWord)
        .first();

        if (countCheck.attempt_count >= 5) {
          return new Response(JSON.stringify({ error: "Maximum attempts (5) reached for this sector." }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // --- SERVER-SIDE AUSTRALIAN DAY VALIDATION ---
        const currentSector = getAustralianSector();
        const isCurrentDay = Number(sector) === currentSector;

        let newWords = [];
        let highestScoreWords = [];
        let isHighest5of5 = false;

        // ONLY evaluate trophies if the submission matches Australian today's sector
        if (isCurrentDay) {
          const existingLogs = await env.DB.prepare(
            `SELECT words_played, sector_total_score, cumulative_words 
             FROM execute_logs 
             WHERE sector = ?`
          )
          .bind(sector)
          .all();

          const existingWords = new Set();
          let maxWordScoreToday = 0;
          let max5of5ScoreToday = 0;

          if (existingLogs && existingLogs.results) {
            for (const row of existingLogs.results) {
              if (row.words_played) {
                try {
                  const words = typeof row.words_played === 'string' ? JSON.parse(row.words_played) : row.words_played;
                  if (Array.isArray(words)) {
                    for (const item of words) {
                      if (item && item.word) {
                        existingWords.add(item.word.toUpperCase());
                        if (typeof item.score === 'number' && item.score > maxWordScoreToday) {
                          maxWordScoreToday = item.score;
                        }
                      }
                    }
                  }
                } catch (e) {}
              }

              if (row.cumulative_words) {
                try {
                  const cum = typeof row.cumulative_words === 'string' ? JSON.parse(row.cumulative_words) : row.cumulative_words;
                  if (Array.isArray(cum) && cum.length === 5) {
                    if (typeof row.sector_total_score === 'number' && row.sector_total_score > max5of5ScoreToday) {
                      max5of5ScoreToday = row.sector_total_score;
                    }
                  }
                } catch (e) {}
              }
            }
          }

          if (Array.isArray(wordsPlayed)) {
            for (const item of wordsPlayed) {
              if (item && item.word) {
                const wUpper = item.word.toUpperCase();
                if (!existingWords.has(wUpper)) {
                  newWords.push(wUpper);
                }
                if (typeof item.score === 'number' && (item.score >= maxWordScoreToday || maxWordScoreToday === 0)) {
                  highestScoreWords.push(wUpper);
                }
              }
            }
          }

          let cumList = [];
          try {
            cumList = typeof cumulativeWords === 'string' ? JSON.parse(cumulativeWords) : cumulativeWords;
          } catch (e) {}

          if (Array.isArray(cumList) && cumList.length === 5) {
            if (typeof sectorTotalScore === 'number' && (sectorTotalScore > max5of5ScoreToday || max5of5ScoreToday === 0)) {
              isHighest5of5 = true;
            }
          }
        }
// --- INJECT TROPHY INTO SYSLOGS BEFORE SAVING ---
        // If they got the highest score, attach the emoji directly to their syslog for this sector
        if (isHighest5of5 && syslogs && syslogs[sector]) {
            syslogs[sector].isHighest5of5 = true;
            syslogs[sector].sectorTrophy = '🏆';
        }

        // Always log play history
        await env.DB.prepare(
          `INSERT INTO execute_logs (
            user_id, sector, score, max_word_length, syslogs,
            words_played, base_word, sector_total_score, cumulative_words
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          userId,
          sector,
          score,
          maxWordLength,
          JSON.stringify(syslogs),
          JSON.stringify(wordsPlayed),
          baseWord,
          sectorTotalScore,
          typeof cumulativeWords === 'string' ? cumulativeWords : JSON.stringify(cumulativeWords)
        )
        .run();

        return new Response(JSON.stringify({ 
          success: true,
          trophies: {
            newWords,
            highestScoreWords,
            isHighest5of5
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
};
