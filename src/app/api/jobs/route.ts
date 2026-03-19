import { JobStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const createJobSchema = z.object({
  company: z.string().trim().min(1, "L'entreprise est obligatoire"),
  role: z.string().trim().min(1, "Le poste est obligatoire"),
  status: z.nativeEnum(JobStatus).optional(),
  location: z.string().trim().optional(),
  salary: z.string().trim().optional(),
  link: z.string().url().optional().or(z.literal("")),
  notes: z.string().trim().optional(),
});

export async function GET() {
  const jobs = await prisma.jobApplication.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });

  return NextResponse.json(jobs);
}

export async function POST(request: Request) {
  const payload = await request.json();
  const parseResult = createJobSchema.safeParse(payload);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Données de candidature invalides", details: parseResult.error.flatten() },
      { status: 400 },
    );
  }

  const data = parseResult.data;

  const created = await prisma.jobApplication.create({
    data: {
      company: data.company,
      role: data.role,
      status: data.status ?? JobStatus.SAVED,
      location: data.location || null,
      salary: data.salary || null,
      link: data.link || null,
      notes: data.notes || null,
    },
  });

  return NextResponse.json(created, { status: 201 });
}
