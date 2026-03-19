import { PrismaClient, MessageRole } from "@prisma/client";
import OpenAI from "openai";
import { WebSocketServer } from "ws";

const prisma = new PrismaClient({ log: ["error", "warn"] });

function resolveAiConfig() {
  const provider = process.env.AI_PROVIDER ?? "openai";

  if (provider === "ollama") {
    return {
      provider,
      apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
      model: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    };
  }

  if (provider === "gemini") {
    return {
      provider,
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
      baseURL:
        process.env.GEMINI_BASE_URL ??
        "https://generativelanguage.googleapis.com/v1beta/openai/",
    };
  }

  return {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
}

function summarizeJobs(jobs) {
  if (!jobs.length) {
    return "Aucune candidature suivie pour le moment.";
  }

  const statusCounts = jobs.reduce(
    (accumulator, job) => {
      accumulator[job.status] += 1;
      return accumulator;
    },
    {
      SAVED: 0,
      APPLIED: 0,
      INTERVIEW: 0,
      OFFER: 0,
      REJECTED: 0,
    },
  );

  const latestJobs = jobs
    .slice(0, 8)
    .map((job) => `- ${job.company} | ${job.role} | ${job.status}`)
    .join("\n");

  return [
    `Total candidatures : ${jobs.length}`,
    `Enregistrées : ${statusCounts.SAVED}`,
    `Envoyées : ${statusCounts.APPLIED}`,
    `Entretiens : ${statusCounts.INTERVIEW}`,
    `Offres : ${statusCounts.OFFER}`,
    `Refusées : ${statusCounts.REJECTED}`,
    "Candidatures récentes :",
    latestJobs,
  ].join("\n");
}

function fallbackReply(userMessage, jobs, reason) {
  const applied = jobs.filter((job) => job.status === "APPLIED").length;
  const interviews = jobs.filter((job) => job.status === "INTERVIEW").length;
  const offers = jobs.filter((job) => job.status === "OFFER").length;

  return [
    `Le mode IA fonctionne en fallback local (${reason}).`,
    "",
    `Tu suis actuellement ${jobs.length} candidatures (${applied} envoyées, ${interviews} entretiens, ${offers} offres).`,
    `Concernant ta question : \"${userMessage}\"`,
    "",
    "Je peux aussi répondre à des questions générales.",
    "Si tu veux un conseil carrière immédiat, je peux te proposer un plan d'action ciblé.",
  ].join("\n");
}

function openAiFailureReason(error) {
  if (error && typeof error === "object" && "status" in error) {
    const status = error.status;
    if (status === 429) {
      return "quota API atteinte ou limite de requêtes dépassée";
    }
    if (status === 401) {
      return "clé API invalide";
    }
  }

  return "erreur temporaire de service IA";
}

function buildSystemPrompt(jobs) {
  return [
    "Tu es un coach carrière IA pratique pour une application de suivi de candidatures.",
    "Donne des conseils concis, concrets et priorisés.",
    "Utilise les données de suivi pour personnaliser tes recommandations.",
    "Si utile, propose des plans d'action courts et des conseils d'entretien.",
    "Tu peux aussi répondre aux questions générales si l'utilisateur sort du contexte recrutement.",
    "N'invente jamais que tu as postulé à la place de l'utilisateur.",
    "Réponds toujours en français.",
    "",
    "Données actuelles du suivi :",
    summarizeJobs(jobs),
  ].join("\n");
}

function buildChatMessages({ jobs, history, userMessage }) {
  const systemPrompt = buildSystemPrompt(jobs);
  const recentHistory = history.slice(-10).map((message) => ({
    role: message.role === "USER" ? "user" : "assistant",
    content: message.content,
  }));

  return [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
  ];
}

async function streamChatbotReply({ jobs, history, userMessage, onDelta }) {
  const aiConfig = resolveAiConfig();
  const { provider, apiKey, model, baseURL } = aiConfig;

  if (!apiKey) {
    return fallbackReply(
      userMessage,
      jobs,
      provider === "gemini"
        ? "GEMINI_API_KEY absente"
        : provider === "ollama"
          ? "OLLAMA_API_KEY absente"
          : "OPENAI_API_KEY absente",
    );
  }

  const client = new OpenAI(
    baseURL
      ? {
          apiKey,
          baseURL,
        }
      : { apiKey },
  );
  const messages = buildChatMessages({ jobs, history, userMessage });

  try {
    const stream = await client.chat.completions.create({
      model,
      temperature: 0.4,
      messages,
      stream: true,
    });

    let fullText = "";
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        fullText += delta;
        onDelta(delta);
      }
    }

    return fullText.trim() || "Je n'ai pas pu générer de réponse pour le moment.";
  } catch (error) {
    try {
      const genericCompletion = await client.chat.completions.create({
        model,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "Tu es un assistant utile et clair. Réponds en français et réponds directement à la question.",
          },
          { role: "user", content: userMessage },
        ],
      });

      const genericReply = genericCompletion.choices?.[0]?.message?.content?.trim();
      if (genericReply) {
        onDelta(genericReply);
        return genericReply;
      }
    } catch {
      return fallbackReply(userMessage, jobs, openAiFailureReason(error));
    }

    return fallbackReply(userMessage, jobs, openAiFailureReason(error));
  }
}

const port = Number(process.env.WS_PORT || 3001);
const wss = new WebSocketServer({ port });

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "system.ready",
      message: "Connexion WebSocket établie",
    }),
  );

  socket.on("message", async (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());

      if (payload?.type !== "chat.send") {
        socket.send(
          JSON.stringify({
            type: "chat.error",
            error: "Type de message WebSocket non supporté",
          }),
        );
        return;
      }

      const sessionId = Number(payload.sessionId);
      const userMessage = String(payload.message ?? "").trim();

      if (!Number.isInteger(sessionId) || sessionId <= 0 || !userMessage) {
        socket.send(
          JSON.stringify({
            type: "chat.error",
            error: "Données de message invalides",
          }),
        );
        return;
      }

      const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        socket.send(
          JSON.stringify({
            type: "chat.error",
            error: "Session introuvable",
          }),
        );
        return;
      }

      const userSaved = await prisma.chatMessage.create({
        data: {
          sessionId,
          role: MessageRole.USER,
          content: userMessage,
        },
      });

      socket.send(
        JSON.stringify({
          type: "chat.user",
          message: userSaved,
        }),
      );

      const [jobs, history] = await Promise.all([
        prisma.jobApplication.findMany({
          orderBy: [{ updatedAt: "desc" }],
          take: 30,
        }),
        prisma.chatMessage.findMany({
          where: { sessionId },
          orderBy: [{ createdAt: "asc" }],
          take: 20,
          select: {
            role: true,
            content: true,
          },
        }),
      ]);

      const assistantTempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      socket.send(
        JSON.stringify({
          type: "chat.assistant.start",
          tempId: assistantTempId,
          sessionId,
        }),
      );

      const assistantReply = await streamChatbotReply({
        jobs,
        history,
        userMessage,
        onDelta: (delta) => {
          socket.send(
            JSON.stringify({
              type: "chat.assistant.delta",
              tempId: assistantTempId,
              sessionId,
              delta,
            }),
          );
        },
      });

      const assistantSaved = await prisma.chatMessage.create({
        data: {
          sessionId,
          role: MessageRole.ASSISTANT,
          content: assistantReply,
        },
      });

      socket.send(
        JSON.stringify({
          type: "chat.assistant.final",
          tempId: assistantTempId,
          message: assistantSaved,
        }),
      );
    } catch {
      socket.send(
        JSON.stringify({
          type: "chat.error",
          error: "Erreur serveur WebSocket lors du traitement du message",
        }),
      );
    }
  });
});

console.log(`Serveur WebSocket chat démarré sur ws://localhost:${port}`);

async function shutdown() {
  await prisma.$disconnect();
  wss.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
