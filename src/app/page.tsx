"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type JobStatus = "SAVED" | "APPLIED" | "INTERVIEW" | "OFFER" | "REJECTED";

type Job = {
  id: number;
  company: string;
  role: string;
  status: JobStatus;
  location: string | null;
  salary: string | null;
  link: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChatSession = {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type ChatMessage = {
  id: number | string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
  sessionId: number;
};

type WebSocketEventPayload =
  | { type: "system.ready"; message: string }
  | { type: "chat.user"; message: ChatMessage }
  | { type: "chat.assistant.start"; tempId: string; sessionId: number }
  | {
      type: "chat.assistant.delta";
      tempId: string;
      sessionId: number;
      delta: string;
    }
  | { type: "chat.assistant.final"; tempId: string; message: ChatMessage }
  | { type: "chat.error"; error: string };

type TransportMode = "websocket" | "sse";

const statusOptions: JobStatus[] = [
  "SAVED",
  "APPLIED",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
];

const statusLabel: Record<JobStatus, string> = {
  SAVED: "Enregistrée",
  APPLIED: "Envoyée",
  INTERVIEW: "Entretien",
  OFFER: "Offre",
  REJECTED: "Refusée",
};

const initialJobForm = {
  company: "",
  role: "",
  status: "SAVED" as JobStatus,
  location: "",
  salary: "",
  link: "",
  notes: "",
};

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || "La requête a échoué");
  }

  return response.json() as Promise<T>;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [jobForm, setJobForm] = useState(initialJobForm);
  const [chatInput, setChatInput] = useState("");
  const [transportMode, setTransportMode] = useState<TransportMode>("websocket");
  const [isLoading, setIsLoading] = useState(true);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const upsertStreamingMessage = useCallback(
    (tempId: string, sessionId: number, delta: string) => {
      setMessages((previous) => {
        const index = previous.findIndex((item) => item.id === tempId);
        if (index === -1) {
          return [
            ...previous,
            {
              id: tempId,
              role: "ASSISTANT",
              content: delta,
              createdAt: new Date().toISOString(),
              sessionId,
            },
          ];
        }

        const next = [...previous];
        next[index] = {
          ...next[index],
          content: `${next[index].content}${delta}`,
        };
        return next;
      });
    },
    [],
  );

  const summary = useMemo(() => {
    return {
      total: jobs.length,
      applied: jobs.filter((job) => job.status === "APPLIED").length,
      interviews: jobs.filter((job) => job.status === "INTERVIEW").length,
      offers: jobs.filter((job) => job.status === "OFFER").length,
    };
  }, [jobs]);

  const loadJobs = useCallback(async () => {
    const data = await parseJson<Job[]>(await fetch("/api/jobs"));
    setJobs(data);
  }, []);

  const loadSessions = useCallback(async (): Promise<ChatSession[]> => {
    const data = await parseJson<ChatSession[]>(await fetch("/api/chat/sessions"));
    return data;
  }, []);

  const ensureSession = useCallback(async (): Promise<number> => {
    const existing = await loadSessions();
    if (existing.length > 0) {
      return existing[0].id;
    }

    const created = await parseJson<ChatSession>(
      await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Fil principal de coaching" }),
      }),
    );

    await loadSessions();
    return created.id;
  }, [loadSessions]);

  const loadMessages = useCallback(async (sessionId: number) => {
    const data = await parseJson<ChatMessage[]>(
      await fetch(`/api/chat/sessions/${sessionId}/messages`),
    );
    setMessages(data);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setIsLoading(true);
        await loadJobs();
        const sessionId = await ensureSession();
        setActiveSessionId(sessionId);
        await loadMessages(sessionId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Erreur inconnue");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [ensureSession, loadJobs, loadMessages]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    loadMessages(activeSessionId).catch((error) => {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible de charger les messages",
      );
    });
  }, [activeSessionId, loadMessages]);

  useEffect(() => {
    if (transportMode !== "websocket") {
      socketRef.current?.close();
      socketRef.current = null;
      setIsWsConnected(false);
      return;
    }

    const wsPort = Number(process.env.NEXT_PUBLIC_WS_PORT || "3001");
    const socket = new WebSocket(`ws://localhost:${wsPort}`);
    socketRef.current = socket;

    socket.onopen = () => {
      setIsWsConnected(true);
    };

    socket.onclose = () => {
      setIsWsConnected(false);
    };

    socket.onerror = () => {
      setIsWsConnected(false);
    };

    socket.onmessage = (event) => {
      try {
        const payload: WebSocketEventPayload = JSON.parse(event.data);

        if (payload.type === "chat.error") {
          setErrorMessage(payload.error);
          setIsSendingChat(false);
          return;
        }

        if (payload.type === "system.ready") {
          return;
        }

        if (
          payload.type === "chat.assistant.start" ||
          payload.type === "chat.assistant.delta"
        ) {
          if (payload.sessionId !== activeSessionId) {
            return;
          }

          if (payload.type === "chat.assistant.start") {
            setMessages((previous) => {
              const alreadyExists = previous.some((item) => item.id === payload.tempId);
              if (alreadyExists) {
                return previous;
              }
              return [
                ...previous,
                {
                  id: payload.tempId,
                  role: "ASSISTANT",
                  content: "",
                  createdAt: new Date().toISOString(),
                  sessionId: payload.sessionId,
                },
              ];
            });
            return;
          }

          upsertStreamingMessage(payload.tempId, payload.sessionId, payload.delta);
          return;
        }

        if (payload.type === "chat.assistant.final") {
          if (payload.message.sessionId !== activeSessionId) {
            return;
          }

          setMessages((previous) => {
            const index = previous.findIndex((item) => item.id === payload.tempId);
            if (index === -1) {
              return [...previous, payload.message];
            }

            const next = [...previous];
            next[index] = payload.message;
            return next;
          });

          setIsSendingChat(false);
          loadSessions().catch(() => null);
          return;
        }

        if (payload.message.sessionId !== activeSessionId) {
          return;
        }

        setMessages((previous) => {
          const alreadyExists = previous.some((item) => item.id === payload.message.id);
          if (alreadyExists) {
            return previous;
          }
          return [...previous, payload.message];
        });

        if (payload.type === "chat.assistant") {
          setIsSendingChat(false);
          loadSessions().catch(() => null);
        }
      } catch {
        setErrorMessage("Message WebSocket invalide reçu");
        setIsSendingChat(false);
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [activeSessionId, loadSessions, transportMode, upsertStreamingMessage]);

  useEffect(() => {
    if (!activeSessionId || transportMode !== "websocket") {
      return;
    }

    const interval = setInterval(() => {
      loadMessages(activeSessionId).catch(() => null);
    }, 4000);

    return () => clearInterval(interval);
  }, [activeSessionId, loadMessages, transportMode]);

  async function sendMessageWithSse(sessionId: number, message: string) {
    const url = `/api/chat/stream?sessionId=${sessionId}&message=${encodeURIComponent(message)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });

    if (!response.ok || !response.body) {
      throw new Error("Impossible de démarrer le flux SSE");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

        const eventLine = lines.find((line) => line.startsWith("event:"));
        const dataLine = lines.find((line) => line.startsWith("data:"));
        if (!eventLine || !dataLine) {
          continue;
        }

        const eventName = eventLine.replace("event:", "").trim();
        const payload = JSON.parse(dataLine.replace("data:", "").trim()) as {
          message?: ChatMessage;
          tempId?: string;
          sessionId?: number;
          delta?: string;
          error?: string;
        };

        if (eventName === "chat.user" && payload.message) {
          if (payload.message.sessionId !== activeSessionId) {
            continue;
          }
          setMessages((previous) => {
            const alreadyExists = previous.some((item) => item.id === payload.message?.id);
            return alreadyExists ? previous : [...previous, payload.message as ChatMessage];
          });
        }

        if (
          eventName === "assistant.start" &&
          payload.tempId &&
          payload.sessionId === activeSessionId
        ) {
          setMessages((previous) => {
            const alreadyExists = previous.some((item) => item.id === payload.tempId);
            if (alreadyExists) {
              return previous;
            }
            return [
              ...previous,
              {
                id: payload.tempId,
                role: "ASSISTANT",
                content: "",
                createdAt: new Date().toISOString(),
                sessionId: payload.sessionId,
              },
            ];
          });
        }

        if (
          eventName === "assistant.delta" &&
          payload.tempId &&
          typeof payload.delta === "string" &&
          payload.sessionId === activeSessionId
        ) {
          upsertStreamingMessage(payload.tempId, payload.sessionId, payload.delta);
        }

        if (eventName === "assistant.final" && payload.tempId && payload.message) {
          if (payload.message.sessionId !== activeSessionId) {
            continue;
          }

          setMessages((previous) => {
            const index = previous.findIndex((item) => item.id === payload.tempId);
            if (index === -1) {
              return [...previous, payload.message as ChatMessage];
            }

            const next = [...previous];
            next[index] = payload.message as ChatMessage;
            return next;
          });

          setIsSendingChat(false);
          await loadSessions().catch(() => null);
        }

        if (eventName === "assistant.error") {
          setErrorMessage(payload.error || "Erreur SSE lors du traitement du message");
          setIsSendingChat(false);
        }
      }
    }
  }

  async function handleCreateJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setErrorMessage(null);
      await parseJson(
        await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jobForm),
        }),
      );
      setJobForm(initialJobForm);
      await loadJobs();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible de créer la candidature",
      );
    }
  }

  async function handleStatusChange(jobId: number, status: JobStatus) {
    try {
      setErrorMessage(null);
      await parseJson(
        await fetch(`/api/jobs/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      );
      await loadJobs();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible de mettre à jour la candidature",
      );
    }
  }

  async function handleDeleteJob(jobId: number) {
    try {
      setErrorMessage(null);
      await parseJson(await fetch(`/api/jobs/${jobId}`, { method: "DELETE" }));
      await loadJobs();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible de supprimer la candidature",
      );
    }
  }

  async function handleResetChat() {
    if (!activeSessionId) {
      return;
    }

    try {
      setErrorMessage(null);
      await parseJson(
        await fetch(`/api/chat/sessions/${activeSessionId}/messages`, {
          method: "DELETE",
        }),
      );
      setMessages([]);
      await loadMessages(activeSessionId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Impossible de réinitialiser le chat",
      );
    }
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatInput.trim() || !activeSessionId) {
      return;
    }

    const message = chatInput.trim();
    setChatInput("");
    setIsSendingChat(true);
    setErrorMessage(null);

    try {
      const socket = socketRef.current;
      if (transportMode === "sse") {
        await sendMessageWithSse(activeSessionId, message);
      } else if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "chat.send",
            sessionId: activeSessionId,
            message,
          }),
        );
      } else {
        const assistant = await parseJson<ChatMessage>(
          await fetch("/api/chat/respond", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: activeSessionId,
              message,
            }),
          }),
        );

        await loadMessages(activeSessionId);
        await loadSessions();
        setMessages((previous) => {
          const alreadyLoaded = previous.some((item) => item.id === assistant.id);
          return alreadyLoaded ? previous : [...previous, assistant];
        });
        setIsSendingChat(false);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Impossible d'envoyer le message",
      );
      setIsSendingChat(false);
    }
  }

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-7xl p-6">
        <p className="text-sm text-zinc-600">Chargement de Job Tracker IA...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Job Application Tracker IA</h1>
        <p className="text-sm text-zinc-600">
          Suis tes candidatures et reçois un coaching IA basé sur ton vrai pipeline.
        </p>
      </header>

      {errorMessage ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <article className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Total</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </article>
        <article className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Envoyées</p>
          <p className="mt-2 text-2xl font-semibold">{summary.applied}</p>
        </article>
        <article className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Entretiens</p>
          <p className="mt-2 text-2xl font-semibold">{summary.interviews}</p>
        </article>
        <article className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Offres</p>
          <p className="mt-2 text-2xl font-semibold">{summary.offers}</p>
        </article>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-6">
          <article className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="text-lg font-medium">Ajouter une candidature</h2>
            <form className="mt-4 grid gap-3" onSubmit={handleCreateJob}>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  required
                  value={jobForm.company}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, company: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  placeholder="Entreprise"
                />
                <input
                  required
                  value={jobForm.role}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, role: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  placeholder="Poste"
                />
                <input
                  value={jobForm.location}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, location: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  placeholder="Localisation"
                />
                <input
                  value={jobForm.salary}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, salary: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  placeholder="Salaire (optionnel)"
                />
                <input
                  value={jobForm.link}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, link: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm sm:col-span-2"
                  placeholder="Lien de l'offre"
                />
                <textarea
                  value={jobForm.notes}
                  onChange={(event) =>
                    setJobForm((previous) => ({ ...previous, notes: event.target.value }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm sm:col-span-2"
                  rows={3}
                  placeholder="Notes"
                />
              </div>

              <div className="flex items-center justify-between">
                <select
                  value={jobForm.status}
                  onChange={(event) =>
                    setJobForm((previous) => ({
                      ...previous,
                      status: event.target.value as JobStatus,
                    }))
                  }
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel[status]}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                >
                  Ajouter
                </button>
              </div>
            </form>
          </article>

          <article className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="text-lg font-medium">Candidatures suivies</h2>

            <ul className="mt-4 space-y-3">
              {jobs.length === 0 ? (
                <li className="text-sm text-zinc-500">Aucune candidature pour le moment.</li>
              ) : (
                jobs.map((job) => (
                  <li
                    key={job.id}
                    className="rounded-md border border-zinc-200 p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {job.role} · {job.company}
                        </p>
                        <p className="text-zinc-600">{job.location || "Localisation non renseignée"}</p>
                        {job.link ? (
                          <a
                            className="text-zinc-800 underline"
                            href={job.link}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Voir l&apos;offre
                          </a>
                        ) : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleDeleteJob(job.id)}
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
                      >
                        Supprimer
                      </button>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <select
                        value={job.status}
                        onChange={(event) =>
                          handleStatusChange(job.id, event.target.value as JobStatus)
                        }
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
                      >
                        {statusOptions.map((status) => (
                          <option key={status} value={status}>
                            {statusLabel[status]}
                          </option>
                        ))}
                      </select>

                      <span className="text-xs text-zinc-500">
                        Mis à jour le {new Date(job.updatedAt).toLocaleDateString("fr-FR")}
                      </span>
                    </div>

                    {job.notes ? <p className="mt-2 text-zinc-700">{job.notes}</p> : null}
                  </li>
                ))
              )}
            </ul>
          </article>
        </div>

        <article className="flex h-[75vh] flex-col rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-200 pb-3">
            <div>
              <h2 className="text-lg font-medium">Coach Carrière IA</h2>
              <p className="text-xs text-zinc-500">Utilise le contexte de tes candidatures</p>
              <p className="text-xs text-zinc-500">
                WebSocket : {isWsConnected ? "connecté" : "déconnecté"}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={transportMode}
                onChange={(event) => setTransportMode(event.target.value as TransportMode)}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
              >
                <option value="websocket">WebSocket + polling</option>
                <option value="sse">SSE (streaming HTTP)</option>
              </select>
              <button
                type="button"
                onClick={handleResetChat}
                disabled={isSendingChat || !activeSessionId}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50"
              >
                Réinitialiser le chat
              </button>
            </div>
          </div>

          <div className="mt-3 flex-1 space-y-3 overflow-y-auto">
            {messages.length === 0 ? (
              <p className="text-sm text-zinc-500">
                Demande de l&apos;aide : CV, relances, préparation d&apos;entretien...
              </p>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[90%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap ${
                    message.role === "USER"
                      ? "ml-auto bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-900"
                  }`}
                >
                  {message.content}
                  {typeof message.id === "string" && message.id.startsWith("tmp-") ? (
                    <span className="ml-1 inline-block animate-pulse">▍</span>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <form onSubmit={sendMessage} className="mt-3 flex gap-2 border-t border-zinc-200 pt-3">
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Pose ta question au coach IA..."
              className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
            <button
              disabled={isSendingChat}
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {isSendingChat ? "Envoi..." : "Envoyer"}
            </button>
          </form>
        </article>
      </section>
    </main>
  );
}
