import OpenAI from "openai";
import { MessageRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

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

function summarizeJobs(
  jobs: { company: string; role: string; status: string }[],
): string {
  if (!jobs.length) {
    return "Aucune candidature suivie pour le moment.";
  }

  const statusCounts = jobs.reduce<Record<string, number>>((accumulator, job) => {
    accumulator[job.status] = (accumulator[job.status] || 0) + 1;
    return accumulator;
  }, {});

  const latestJobs = jobs
    .slice(0, 8)
    .map((job) => `- ${job.company} | ${job.role} | ${job.status}`)
    .join("\n");

  return [
    `Total candidatures : ${jobs.length}`,
    `Enregistrées : ${statusCounts.SAVED || 0}`,
    `Envoyées : ${statusCounts.APPLIED || 0}`,
    `Entretiens : ${statusCounts.INTERVIEW || 0}`,
    `Offres : ${statusCounts.OFFER || 0}`,
    `Refusées : ${statusCounts.REJECTED || 0}`,
    "Candidatures récentes :",
    latestJobs,
  ].join("\n");
}

function fallbackReply(
  userMessage: string,
  jobs: { status: string }[],
  reason: string,
): string {
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

function buildPrompt(
  jobs: { company: string; role: string; status: string }[],
  history: { role: MessageRole; content: string }[],
  userMessage: string,
) {
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

  return [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
  ] as const;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = Number(searchParams.get("sessionId"));
  const userMessage = (searchParams.get("message") ?? "").trim();

  if (!Number.isInteger(sessionId) || sessionId <= 0 || !userMessage) {
    return new Response("Paramètres invalides", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      (async () => {
        try {
          const session = await prisma.chatSession.findUnique({
            where: { id: sessionId },
          });

          if (!session) {
            sendEvent("assistant.error", { error: "Session introuvable" });
            controller.close();
            return;
          }

          const userSaved = await prisma.chatMessage.create({
            data: {
              sessionId,
              role: MessageRole.USER,
              content: userMessage,
            },
          });

          sendEvent("chat.user", { message: userSaved });

          const [jobs, history] = await Promise.all([
            prisma.jobApplication.findMany({
              orderBy: [{ updatedAt: "desc" }],
              take: 30,
              select: {
                company: true,
                role: true,
                status: true,
              },
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

          const aiConfig = resolveAiConfig();
          const { provider, apiKey, model, baseURL } = aiConfig;

          const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          sendEvent("assistant.start", { tempId, sessionId });

          if (!apiKey) {
            const fallback = fallbackReply(
              userMessage,
              jobs,
              provider === "gemini"
                ? "GEMINI_API_KEY absente"
                : provider === "ollama"
                  ? "OLLAMA_API_KEY absente"
                  : "OPENAI_API_KEY absente",
            );

            sendEvent("assistant.delta", { tempId, sessionId, delta: fallback });

            const savedAssistant = await prisma.chatMessage.create({
              data: {
                sessionId,
                role: MessageRole.ASSISTANT,
                content: fallback,
              },
            });

            sendEvent("assistant.final", { tempId, message: savedAssistant });
            controller.close();
            return;
          }

          const client = new OpenAI(
            baseURL
              ? {
                  apiKey,
                  baseURL,
                }
              : { apiKey },
          );

          const messages = buildPrompt(jobs, history, userMessage);

          let fullText = "";
          try {
            const completion = await client.chat.completions.create({
              model,
              temperature: 0.4,
              messages: [...messages],
              stream: true,
            });

            for await (const chunk of completion) {
              const delta = chunk.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                fullText += delta;
                sendEvent("assistant.delta", { tempId, sessionId, delta });
              }
            }
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

              const genericReply =
                genericCompletion.choices?.[0]?.message?.content?.trim() || "";

              if (genericReply) {
                fullText = genericReply;
                sendEvent("assistant.delta", { tempId, sessionId, delta: genericReply });
              } else {
                const fallback = fallbackReply(
                  userMessage,
                  jobs,
                  openAiFailureReason(error),
                );
                fullText = fallback;
                sendEvent("assistant.delta", { tempId, sessionId, delta: fallback });
              }
            } catch {
              const fallback = fallbackReply(userMessage, jobs, openAiFailureReason(error));
              fullText = fallback;
              sendEvent("assistant.delta", { tempId, sessionId, delta: fallback });
            }
          }

          const finalText =
            fullText.trim() || "Je n'ai pas pu générer de réponse pour le moment.";

          const savedAssistant = await prisma.chatMessage.create({
            data: {
              sessionId,
              role: MessageRole.ASSISTANT,
              content: finalText,
            },
          });

          sendEvent("assistant.final", { tempId, message: savedAssistant });
          controller.close();
        } catch {
          sendEvent("assistant.error", {
            error: "Erreur serveur SSE lors du traitement du message",
          });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
