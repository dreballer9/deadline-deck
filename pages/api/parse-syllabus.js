import { createClient } from '@supabase/supabase-js';

// Server-only admin client, used just to verify who's calling this endpoint.
// SUPABASE_SERVICE_ROLE_KEY must NEVER be exposed to the browser.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require a logged-in Supabase user so random visitors can't burn your AI budget.
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !supabaseAdmin) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });
  }

  const { text, existingCourses, year } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing syllabus text' });
  }

  const prompt = `You extract info from a university course syllabus. Read the ENTIRE text carefully, including any weekly/class schedule or course calendar table — these tables are often where most graded dates actually live, and their dates are usually easy to read even when the item name is abbreviated.

Be thorough:
- Scan the full schedule line by line. If you see a recurring abbreviated code next to dates throughout the term (e.g. "ICA #1", "ICA#2", "HW1", "Lab 4", "Quiz 2"), treat EACH occurrence as its own dated item — do not skip it just because it's abbreviated.
- If the syllabus defines the abbreviation elsewhere, expand it in the title; otherwise keep it as written.
- Also include items from any separate "assignments," "exams," or "important dates" list, in addition to the schedule table.

Also decide the course label: find a short course code (e.g. "MGMT 1301") and/or the full course title (e.g. "Money and Banking") if stated anywhere.
Here are course labels already on this student's calendar for this semester: ${JSON.stringify(existingCourses || [])}
If, and ONLY if, you are highly confident the course you just found is literally the SAME class as one of those existing labels — just referred to differently (e.g. the exact full title you now found IS the name of a class previously logged only by its short code, or vice versa, with matching subject matter) — set "mergeInto" to that exact existing label string. Two different course codes (e.g. "MGMT 1301" vs "MGMT 1601") are DIFFERENT courses even if they share a department prefix, sound similar, or have similarly-named assignments — never merge those. When in doubt, set "mergeInto" to null; a missed merge is far less harmful than wrongly combining two different classes.

Return ONLY JSON, no prose, no markdown fences, in this exact shape:
{"courseCode": "short code or null", "courseName": "full title or null", "mergeInto": "exact existing label or null", "items": [{"title": "short assignment/exam name", "date": "YYYY-MM-DD", "time": "24-hour HH:MM if a specific time is stated, else null", "type": "assignment|test|deliverable"}]}

Use "test" for exams/quizzes/midterms/finals, "deliverable" for projects/reports/presentations, "assignment" for homework/problem sets/labs/in-class assignments. Skip items without a specific date. If a year is not stated, infer it or use ${year || new Date().getFullYear()}.

Syllabus text:
${text.slice(0, 150000)}`;

  // Try a couple of free-tier models in order, with a short retry, so a busy
  // model doesn't just fail the upload. Newest/most-capable first.
  const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function callGemini(model) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: 'application/json', temperature: 0.2 }
        })
      }
    );
    const data = await r.json();
    return { ok: r.ok, status: r.status, data };
  }

  try {
    let lastError = 'Gemini API error';
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { ok, status, data } = await callGemini(model);
        if (ok) {
          const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            return res.status(502).json({ error: 'Model did not return valid JSON', raw });
          }
          // Safety net: never trust the model's merge call across two different
          // department codes (e.g. "MGMT 1301" vs "ECON 2326"). If both the new
          // course and the merge target look like "LETTERS NUMBERS" codes with
          // different letter prefixes, refuse the merge no matter what the model said.
          if (parsed && typeof parsed === 'object' && parsed.mergeInto) {
            const deptPrefix = (label) => {
              const m = String(label || '').trim().match(/^[A-Za-z]{2,}/);
              return m ? m[0].toUpperCase() : null;
            };
            const newDept = deptPrefix(parsed.courseCode || parsed.courseName);
            const mergeDept = deptPrefix(parsed.mergeInto);
            if (newDept && mergeDept && newDept !== mergeDept) {
              parsed.mergeInto = null;
            }
          }
          return res.status(200).json(parsed);
        }
        lastError = data.error?.message || 'Gemini API error';
        const overloaded = status === 503 || /overloaded|high demand|unavailable/i.test(lastError);
        if (overloaded && attempt === 0) {
          await sleep(1500); // brief retry on the same model before moving on
          continue;
        }
        if (overloaded) break; // move to the next fallback model
        // Non-overload error (bad request, auth, etc.) - no point retrying or falling back.
        return res.status(502).json({ error: lastError });
      }
    }
    return res.status(503).json({ error: 'All AI models are currently busy. Please try again in a minute: ' + lastError });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
