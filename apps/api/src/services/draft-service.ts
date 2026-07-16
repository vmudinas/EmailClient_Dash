import {
  gmailSendRequestSchema,
  type EmailDraft,
  type EmailDraftCreate,
  type EmailDraftUpdate,
  type GmailSendResult
} from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import type { GmailService } from "./gmail-service.js";
import type { ResumeService } from "./resume-service.js";

export class DraftService {
  constructor(
    private readonly database: EmailStore,
    private readonly gmail: GmailService,
    private readonly resumes: ResumeService
  ) {}

  list(): EmailDraft[] {
    return this.database.listEmailDrafts();
  }

  get(id: string): EmailDraft {
    const draft = this.database.getEmailDraft(id);
    if (!draft) throw new DraftNotFoundError("Draft not found");
    return draft;
  }

  create(input: EmailDraftCreate): EmailDraft {
    return this.database.createEmailDraft(input);
  }

  update(id: string, input: EmailDraftUpdate): EmailDraft {
    if (!this.database.getEmailDraft(id)) throw new DraftNotFoundError("Draft not found");
    return this.database.updateEmailDraft(id, input);
  }

  remove(id: string): void {
    if (!this.database.deleteEmailDraft(id)) throw new DraftNotFoundError("Draft not found");
  }

  async send(id: string): Promise<GmailSendResult> {
    const draft = this.get(id);
    const parsed = gmailSendRequestSchema.safeParse({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      bodyText: draft.bodyText,
      ...(draft.fromAddress ? { fromAddress: draft.fromAddress } : {})
    });
    if (!parsed.success) {
      throw new DraftValidationError(parsed.error.issues[0]?.message ?? "Complete the draft before sending");
    }
    const attachments = draft.resumeId
      ? [await this.resumes.read(draft.resumeId)].map(({ asset, content }) => ({
          filename: asset.filename,
          contentType: asset.contentType,
          content
        }))
      : [];
    const result = await this.gmail.sendMessage(draft.connectionId, parsed.data, attachments);
    this.database.deleteEmailDraft(id);
    this.database.recordDiagnostic({
      level: "info",
      category: "gmail",
      message: draft.resumeId ? "Draft sent with resume attachment" : "Draft sent",
      context: {
        operation: "draft_send",
        draftId: id,
        source: draft.source,
        connectionId: draft.connectionId,
        resumeId: draft.resumeId
      }
    });
    return result;
  }
}

export class DraftNotFoundError extends Error {}
export class DraftValidationError extends Error {}
