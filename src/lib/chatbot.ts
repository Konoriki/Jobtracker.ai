import OpenAI from "openai";
import { JobApplication, JobStatus, MessageRole } from "@prisma/client";

type ChatContext = {
  jobs: JobApplication[];
  history: { role: MessageRole; content: string }[];
  userMessage: string;
};

type AiProvider = "openai" | "gemini" | "ollama";

function resolveAiConfig(): {
  provider: AiProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
} {
  const provider = (process.env.AI_PROVIDER ?? "openai") as AiProvider;

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

function openAiFailureReason(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      return "quota API atteinte ou limite de requêtes dépassée";
    }
    if (status === 401) {
      return "clé API invalide";
    }
  }

  return "erreur temporaire de service IA";
}

function summarizeJobs(jobs: JobApplication[]): string {
  if (!jobs.length) {
    return "Aucune candidature suivie pour le moment.";
  }

  const statusCounts = jobs.reduce<Record<JobStatus, number>>(
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

function fallbackReply(
  userMessage: string,
  jobs: JobApplication[],
  reason?: string,
): string {
  const applied = jobs.filter((job) => job.status === "APPLIED").length;
  const interviews = jobs.filter((job) => job.status === "INTERVIEW").length;
  const offers = jobs.filter((job) => job.status === "OFFER").length;

  return [
    reason
      ? `Le mode IA fonctionne en fallback local (${reason}).`
      : "Le mode IA fonctionne en fallback local car OPENAI_API_KEY est absente.",
    "",
    `Tu suis actuellement ${jobs.length} candidatures (${applied} envoyées, ${interviews} entretiens, ${offers} offres).`,
    `Concernant ta question : \"${userMessage}\"`,
    "",
    "Je peux aussi répondre à des questions générales.",
    "Si tu veux un conseil carrière immédiat, je peux te proposer un plan d'action ciblé.",
  ].join("\n");
}

async function tryGenericReply(client: OpenAI, model: string, userMessage: string) {
  const completion = await client.chat.completions.create({
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

  return completion.choices[0]?.message?.content?.trim();
}

export async function generateChatbotReply({
  jobs,
  history,
  userMessage,
}: ChatContext): Promise<string> {
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

  const systemPrompt = [
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

  const recentHistory = history.slice(-10).map((message) => ({
    role: message.role === "USER" ? "user" : "assistant",
    content: message.content,
  }));

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        ...recentHistory,
        { role: "user", content: userMessage },
      ],
    });

    return (
      completion.choices[0]?.message?.content?.trim() ||
      "Je n'ai pas pu générer de réponse pour le moment."
    );
  } catch (error) {
    try {
      const genericReply = await tryGenericReply(client, model, userMessage);
      if (genericReply) {
        return genericReply;
      }
    } catch {
      return fallbackReply(userMessage, jobs, openAiFailureReason(error));
    }

    return fallbackReply(userMessage, jobs, openAiFailureReason(error));
  }
}
