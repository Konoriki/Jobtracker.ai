import { JobStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const updateJobSchema = z.object({
  company: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  status: z.nativeEnum(JobStatus).optional(),
  location: z.string().trim().optional().nullable(),
  salary: z.string().trim().optional().nullable(),
  link: z.string().url().optional().or(z.literal("")).nullable(),
  notes: z.string().trim().optional().nullable(),
});

function parseId(id: string): number | null {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const params = await context.params;
  const id = parseId(params.id);

  if (!id) {
    return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  }

  const payload = await request.json();
  const parseResult = updateJobSchema.safeParse(payload);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Données invalides", details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const updated = await prisma.jobApplication.update({
      where: { id },
      data: {
        ...parseResult.data,
        link:
          parseResult.data.link === undefined
            ? undefined
            : parseResult.data.link || null,
      },
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Candidature introuvable" }, { status: 404 });
  }
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

  try {
    await prisma.jobApplication.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Candidature introuvable" }, { status: 404 });
  }
}
