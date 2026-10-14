import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.GEMINI_API_KEY;
const API = "https://generativelanguage.googleapis.com/v1beta";
const LANGS = { RU: "русском", KZ: "казахском", EN: "English" };
const hits = new Map();
let model = process.env.GEMINI_MODEL || ""; // пусто = подобрать автоматически
let available = null;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Gemini helpers ---------- */
async function gfetch(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY, ...(init.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function listModels() {
  if (available) return available;
  const d = await gfetch(`${API}/models?pageSize=200`);
  available = (d.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  if (!available.length) throw new Error("Google API не вернул модели для generateContent. Проверьте ключ и доступ к API.");
  return available;
}

async function pickModel() {
  const all = await listModels();
  const flash = all.filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|robotics|computer|exp/.test(n));
  const full = flash.filter((n) => !/lite/.test(n));
  return (
    flash.find((n) => n === "gemini-flash-latest") ||
    full.sort().reverse()[0] ||
    flash.sort().reverse()[0] ||
    all[0]
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(body, tries = 0) {
  if (!model) model = await pickModel();
  try {
    return await gfetch(`${API}/models/${model}:generateContent`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    if (e.status === 404) {
      available = null;
      const next = await pickModel().catch(() => null);
      if (next && next !== model) {
        console.log(`Модель ${model} недоступна, перехожу на ${next}`);
        model = next;
        return generate(body, tries);
      }
    }
    if ([429, 503].includes(e.status) && tries < 2) {
      await sleep(1500 * (tries + 1));
      return generate(body, tries + 1);
    }
    throw e;
  }
}

const limited = (ip) => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  // Keep the in-memory limiter bounded on long-running public deployments.
  if (hits.size > 2_000) {
    for (const [key, times] of hits) if (!times.some((t) => now - t < 60_000)) hits.delete(key);
    if (hits.size > 2_000) hits.delete(hits.keys().next().value);
  }
  return list.length > 20;
};

/* ---------- API ---------- */
app.get("/api/health", (_req, res) =>
  res.json({ status: "online", service: "BILIMHUB AI Mentor", provider: "Google Gemini", model: model || "auto", keyConfigured: Boolean(KEY) })
);

app.get("/api/models", async (_req, res) => {
  if (!KEY) return res.status(503).json({ error: "GEMINI_API_KEY не задан." });
  try {
    res.json({ current: model || (await pickModel()), available: await listModels() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/mentor", async (req, res) => {
  const { message, language = "RU", history = [] } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "Введите сообщение." });
  if (!KEY) return res.status(503).json({ error: "На сервере не задан GEMINI_API_KEY. Добавьте ключ в .env." });
  if (limited(req.ip)) return res.status(429).json({ error: "Слишком много запросов. Подождите минуту." });

  const past = (Array.isArray(history) ? history : [])
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-12);
  const contents = [...past, { role: "user", content: message.trim() }].map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content.slice(0, 4000) }]
  }));
  while (contents.length && contents[0].role === "model") contents.shift();

  try {
    const data = await generate({
      systemInstruction: {
        parts: [{
          text: `Ты — BILIMHUB AI Mentor, наставник для учащихся Казахстана и Центральной Азии. Помогай с программированием, учебными проектами, планами обучения и собеседованиями. Отвечай на ${LANGS[language] || LANGS.RU} языке, если пользователь не пишет на другом. Будь точным и кратким, код давай в блоках \`\`\`. Не выдумывай партнёрства, вакансии и статистику BILIMHUB.`
        }]
      },
      contents
    });
    if (data.promptFeedback?.blockReason) return res.status(422).json({ error: "Запрос отклонён фильтрами безопасности. Переформулируйте вопрос." });
    const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!reply) return res.status(502).json({ error: "ИИ вернул пустой ответ. Попробуйте ещё раз." });
    res.json({ reply, model });
  } catch (error) {
    console.error("BILIMHUB AI error:", error.status, error.message);
    const map = {
      400: "Запрос отклонён. Проверьте GEMINI_API_KEY в .env.",
      403: "Ключ не имеет доступа. Проверьте GEMINI_API_KEY и доступность Gemini в вашем регионе.",
      404: "Подходящая модель не найдена. Откройте /api/models, чтобы увидеть доступные.",
      429: "Достигнут лимит бесплатного уровня. Подождите и попробуйте снова.",
      503: "Сервис Gemini перегружен. Попробуйте через минуту."
    };
    const status = [400, 403, 404, 429, 503].includes(error.status) ? error.status : (error.name === "TimeoutError" ? 504 : 502);
    res.status(status).json({ error: map[error.status] || (error.name === "TimeoutError" ? "ИИ не ответил за 30 секунд. Попробуйте ещё раз." : "Не удалось связаться с ИИ. Смотрите терминал сервера.") });
  }
});

// Return useful JSON for malformed requests instead of Express' default HTML error page.
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Сообщение слишком большое. Сократите запрос." });
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "Некорректный JSON в запросе." });
  console.error("HTTP error:", err?.message || err);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`BILIMHUB running at http://localhost:${PORT}`);
  console.log(KEY ? "Gemini: ключ найден" : "Gemini: ключ НЕ найден — добавьте GEMINI_API_KEY в .env");
});
