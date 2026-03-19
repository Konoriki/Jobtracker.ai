import { MessageRole } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generateChatbotReply } from "@/lib/chatbot";
import { prisma } from "@/lib/prisma";

const chatRequestSchema = z.object({
  sessionId: z.number().int().positive(),
  message: z.string().trim().min(1).max(2000),
});

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const parseResult = chatRequestSchema.safeParse(payload);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Données de message invalides",
          details: parseResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const { sessionId, message } = parseResult.data;

    const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: "Session introuvable" }, { status: 404 });
    }

    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: MessageRole.USER,
        content: message,
      },
    });

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

    const assistantReply = await generateChatbotReply({
      jobs,
      history,
      userMessage: message,
    });

    const savedAssistantMessage = await prisma.chatMessage.create({
      data: {
        sessionId,
        role: MessageRole.ASSISTANT,
        content: assistantReply,
      },
    });

    return NextResponse.json(savedAssistantMessage, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Erreur serveur lors du traitement du message" },
      { status: 500 },
    );
  }
}
