import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});

export async function GET() {
  const sessions = await prisma.chatSession.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });

  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const parseResult = createSessionSchema.safeParse(payload);

  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Données de session invalides",
        details: parseResult.error.flatten(),
      },
      { status: 400 },
    );
  }

  const session = await prisma.chatSession.create({
    data: {
      title: parseResult.data.title ?? "Coaching emploi",
    },
  });

  return NextResponse.json(session, { status: 201 });
}
