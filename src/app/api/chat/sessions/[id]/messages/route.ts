import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function parseId(id: string): number | null {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const params = await context.params;
  const id = parseId(params.id);

  if (!id) {
    return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  }

  const session = await prisma.chatSession.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: [{ createdAt: "asc" }],
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session introuvable" }, { status: 404 });
  }

  return NextResponse.json(session.messages);
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const params = await context.params;
  const id = parseId(params.id);

  if (!id) {
    return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  }

  const session = await prisma.chatSession.findUnique({ where: { id } });
  if (!session) {
    return NextResponse.json({ error: "Session introuvable" }, { status: 404 });
  }

  await prisma.chatMessage.deleteMany({
    where: { sessionId: id },
  });

  return NextResponse.json({ success: true });
}
