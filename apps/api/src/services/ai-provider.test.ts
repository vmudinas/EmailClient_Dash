import { describe, expect, it } from "vitest";
import type { MessageDetail } from "@email-client/shared";
import { createAiProvider, DeepSeekProvider, OpenAiProvider } from "./ai-provider.js";

describe("createAiProvider", () => {
  it("selects the provider implementation by id", () => {
    expect(createAiProvider("openai", "sk-test", "gpt-test")).toBeInstanceOf(OpenAiProvider);
    expect(createAiProvider("deepseek", "sk-test", "deepseek-chat")).toBeInstanceOf(DeepSeekProvider);
  });
});

describe("DeepSeekProvider", () => {
  it("analyzes a message against DeepSeek's OpenAI-compatible chat completions endpoint", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://api.deepseek.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-deepseek-test");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: url.pathname, body });
      if (url.pathname === "/chat/completions") {
        return jsonResponse({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "deepseek-chat",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "A vendor sent an invoice for last month's services.",
                categories: ["Finance"],
                priority: "normal",
                actionRequired: true,
                actionSummary: "Pay the invoice",
                spamProbability: 0.02,
                phishingProbability: 0.01,
                draftRecommended: false,
                confidence: 0.9,
                signals: ["Recognized vendor domain"]
              })
            },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 210, completion_tokens: 48, total_tokens: 258 }
        });
      }
      throw new Error(`Unexpected DeepSeek test request: ${url}`);
    };
    const provider = new DeepSeekProvider("sk-deepseek-test", "deepseek-chat", fetcher);

    const result = await provider.analyze(messageFixture(), undefined, {
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on invoices that need approval before Friday."
    });

    expect(result.analysis).toMatchObject({
      summary: "A vendor sent an invoice for last month's services.",
      priority: "normal",
      actionRequired: true
    });
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 48 });
    expect(requests[0]?.url).toBe("/chat/completions");
    expect(requests[0]?.body).toMatchObject({
      model: "deepseek-chat",
      response_format: { type: "json_object" }
    });
    const messages = requests[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("Summarize");
    expect(messages[0]?.content).toContain("Extract actions");
    expect(messages[0]?.content).toContain("Focus on invoices that need approval before Friday.");
  });

  it("surfaces an invalid API key as a non-retryable, provider-labeled error", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
    const provider = new DeepSeekProvider("sk-bad-key", "deepseek-chat", fetcher);

    await expect(provider.analyze(messageFixture())).rejects.toMatchObject({
      message: "DeepSeek rejected the API key",
      retryable: false
    });
  });

  it("tests the connection against the models list endpoint", async () => {
    let called = false;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/models");
      called = true;
      return jsonResponse({ object: "list", data: [{ id: "deepseek-chat", object: "model" }] });
    };
    const provider = new DeepSeekProvider("sk-deepseek-test", "deepseek-chat", fetcher);

    await provider.testConnection();
    expect(called).toBe(true);
  });

  it("lists live models sorted by id, enriched with known pricing and a fallback for unknown ids", async () => {
    const fetcher: typeof fetch = async () => jsonResponse({
      object: "list",
      data: [
        { id: "deepseek-v4-pro", object: "model" },
        { id: "deepseek-v4-flash", object: "model" },
        { id: "some-brand-new-model", object: "model" }
      ]
    });
    const provider = new DeepSeekProvider("sk-deepseek-test", "deepseek-v4-flash", fetcher);

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "some-brand-new-model"]);
    expect(models[0]).toMatchObject({ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" });
    expect(models[0]?.pricing).toContain("per 1M");
    expect(models[2]).toEqual({ id: "some-brand-new-model", label: "some-brand-new-model", description: null, pricing: null });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function messageFixture(): MessageDetail {
  return {
    id: "message-1",
    archiveId: "archive-1",
    folderId: "folder-1",
    folderPath: "Inbox",
    subject: "Invoice for June services",
    sender: { name: "Vendor", address: "billing@vendor.example" },
    recipients: [{ name: "Owner", address: "owner@example.test" }],
    sentAt: "2026-07-01T12:00:00.000Z",
    receivedAt: "2026-07-01T12:00:05.000Z",
    preview: "Please find attached the invoice for June.",
    hasAttachments: false,
    attachmentCount: 0,
    state: { isRead: false, isStarred: false, tags: [], note: null },
    to: [{ name: "Owner", address: "owner@example.test" }],
    cc: [],
    bcc: [],
    bodyText: "Please find attached the invoice for June services.",
    bodyHtml: null,
    headers: { "message-id": "<invoice-1@vendor.example>" },
    attachments: []
  };
}
