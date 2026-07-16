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
import { applyDraftSenderName, type DraftSettingsManager } from "./draft-settings.js";

export class DraftService {
  constructor(
    private readonly database: EmailStore,
    private readonly gmail: GmailService,
    private readonly resumes: ResumeService,
    private readonly settings: DraftSettingsManager
  ) {}

  list(): EmailDraft[] {
    return this.database.listEmailDrafts().map((draft) => this.applyIdentity(draft));
  }

  get(id: string): EmailDraft {
    const draft = this.database.getEmailDraft(id);
    if (!draft) throw new DraftNotFoundError("Draft not found");
    return this.applyIdentity(draft);
  }

  create(input: EmailDraftCreate): EmailDraft {
    const identity = this.settings.current();
    return this.applyIdentity(this.database.createEmailDraft({
      ...input,
      fromAddress: input.fromAddress ?? identity.defaultFromAddress,
      subject: applyDraftSenderName(input.subject, identity.senderName),
      bodyText: applyDraftSenderName(input.bodyText, identity.senderName)
    }));
  }

  update(id: string, input: EmailDraftUpdate): EmailDraft {
    if (!this.database.getEmailDraft(id)) throw new DraftNotFoundError("Draft not found");
    const identity = this.settings.current();
    return this.applyIdentity(this.database.updateEmailDraft(id, {
      ...input,
      ...(input.subject !== undefined
        ? { subject: applyDraftSenderName(input.subject, identity.senderName) }
        : {}),
      ...(input.bodyText !== undefined
        ? { bodyText: applyDraftSenderName(input.bodyText, identity.senderName) }
        : {})
    }));
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

  private applyIdentity(draft: EmailDraft): EmailDraft {
    const identity = this.settings.current();
    return {
      ...draft,
      fromAddress: draft.fromAddress ?? identity.defaultFromAddress,
      subject: applyDraftSenderName(draft.subject, identity.senderName),
      bodyText: applyDraftSenderName(draft.bodyText, identity.senderName)
    };
  }
}

export class DraftNotFoundError extends Error {}
export class DraftValidationError extends Error {}
