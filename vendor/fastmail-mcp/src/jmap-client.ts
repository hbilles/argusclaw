/**
 * JMAP Client — ArgusClaw fork with defensive response parsing.
 *
 * Changes from upstream (github:MadLlama25/fastmail-mcp v1.6.1):
 * - Added extractMethodResponse() helper for safe JMAP response parsing
 * - All methods now validate response structure before accessing nested properties
 * - JMAP error responses (method name "error") are detected and thrown with details
 */
import { FastmailAuth } from './auth.js';

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  capabilities: Record<string, any>;
  downloadUrl?: string;
  uploadUrl?: string;
}

export interface JmapRequest {
  using: string[];
  methodCalls: [string, any, string][];
}

export interface JmapResponse {
  methodResponses: Array<[string, any, string]>;
  sessionState: string;
}

// ---------------------------------------------------------------------------
// Defensive response parsing helper
// ---------------------------------------------------------------------------

/**
 * Safely extract a method response result from a JMAP response.
 *
 * JMAP responses are arrays of [methodName, result, callId].
 * This validates the structure and throws descriptive errors on failure.
 */
function _extractMethodResponse(
  response: JmapResponse,
  index: number,
  methodName: string,
): any {
  if (!response.methodResponses || !Array.isArray(response.methodResponses)) {
    throw new Error(
      `JMAP response has no methodResponses array for ${methodName}.`
    );
  }

  const entry = response.methodResponses[index];
  if (!entry) {
    throw new Error(
      `JMAP response missing entry at index ${index} for ${methodName}. ` +
      `Got ${response.methodResponses.length} response(s).`
    );
  }

  // JMAP error responses have the method name "error"
  if (entry[0] === 'error') {
    const err = entry[1] as { type?: string; description?: string };
    throw new Error(
      `JMAP error for ${methodName}: ${err.type ?? 'unknown'} — ${err.description ?? 'no description'}`
    );
  }

  const result = entry[1];
  if (result == null) {
    throw new Error(
      `JMAP response entry at index ${index} for ${methodName} has null/undefined result.`
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// JmapClient
// ---------------------------------------------------------------------------

export class JmapClient {
  private auth: FastmailAuth;
  private session: JmapSession | null = null;

  constructor(auth: FastmailAuth) {
    this.auth = auth;
  }

  async getSession(): Promise<JmapSession> {
    if (this.session) {
      return this.session;
    }

    const response = await fetch(this.auth.getSessionUrl(), {
      method: 'GET',
      headers: this.auth.getAuthHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to get JMAP session: ${response.status} ${response.statusText}`);
    }

    const sessionData = await response.json() as any;

    if (!sessionData.apiUrl) {
      throw new Error('JMAP session response missing apiUrl');
    }
    if (!sessionData.accounts || Object.keys(sessionData.accounts).length === 0) {
      throw new Error('JMAP session response has no accounts');
    }

    // Use primaryAccounts to select the correct account for mail operations.
    // Object.keys(accounts)[0] is unreliable — ordering isn't guaranteed and
    // the session may contain multiple accounts (e.g., a contacts-only account
    // alongside the primary mail account).
    const primaryAccounts = sessionData.primaryAccounts as Record<string, string> | undefined;
    const accountId =
      primaryAccounts?.['urn:ietf:params:jmap:mail'] ??
      primaryAccounts?.['urn:ietf:params:jmap:core'] ??
      Object.keys(sessionData.accounts)[0];

    this.session = {
      apiUrl: sessionData.apiUrl,
      accountId,
      capabilities: sessionData.capabilities ?? {},
      downloadUrl: sessionData.downloadUrl,
      uploadUrl: sessionData.uploadUrl
    };

    return this.session;
  }

  async getUserEmail(): Promise<string> {
    try {
      const identity = await this.getDefaultIdentity();
      return identity?.email || 'user@example.com';
    } catch {
      return 'user@example.com';
    }
  }

  async makeRequest(request: JmapRequest): Promise<JmapResponse> {
    const session = await this.getSession();

    const response = await fetch(session.apiUrl, {
      method: 'POST',
      headers: this.auth.getAuthHeaders(),
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`JMAP request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as JmapResponse;
  }

  /**
   * Public access to the safe response extractor (used by index.ts for
   * inline JMAP calls like search_emails).
   */
  extractMethodResponse(response: JmapResponse, index: number, methodName: string): any {
    return _extractMethodResponse(response, index, methodName);
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  async getMailboxes(): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Mailbox/get', { accountId: session.accountId }, 'mailboxes']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Mailbox/get');
    return result.list ?? [];
  }

  // -------------------------------------------------------------------------
  // Emails
  // -------------------------------------------------------------------------

  async getEmails(mailboxId?: string, limit: number = 20): Promise<any[]> {
    const session = await this.getSession();

    const filter = mailboxId ? { inMailbox: mailboxId } : {};

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 1, 'Email/get');
    return result.list ?? [];
  }

  async getEmailById(id: string): Promise<any> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [id],
          properties: ['id', 'subject', 'from', 'to', 'cc', 'bcc', 'receivedAt', 'textBody', 'htmlBody', 'attachments', 'bodyValues'],
          bodyProperties: ['partId', 'blobId', 'type', 'size'],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        }, 'email']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/get');

    if (result.notFound && result.notFound.includes(id)) {
      throw new Error(`Email with ID '${id}' not found`);
    }

    const email = result.list?.[0];
    if (!email) {
      throw new Error(`Email with ID '${id}' not found or not accessible`);
    }

    return email;
  }

  // -------------------------------------------------------------------------
  // Identities
  // -------------------------------------------------------------------------

  async getIdentities(): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
      methodCalls: [
        ['Identity/get', {
          accountId: session.accountId
        }, 'identities']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Identity/get');
    return result.list ?? [];
  }

  async getDefaultIdentity(): Promise<any> {
    const identities = await this.getIdentities();
    return identities.find((id: any) => id.mayDelete === false) || identities[0];
  }

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(email: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    from?: string;
    mailboxId?: string;
  }): Promise<string> {
    const session = await this.getSession();

    const identities = await this.getIdentities();
    if (!identities || identities.length === 0) {
      throw new Error('No sending identities found');
    }

    let selectedIdentity;
    if (email.from) {
      selectedIdentity = identities.find((id: any) =>
        id.email.toLowerCase() === email.from?.toLowerCase()
      );
      if (!selectedIdentity) {
        throw new Error('From address is not verified for sending. Choose one of your verified identities.');
      }
    } else {
      selectedIdentity = identities.find((id: any) => id.mayDelete === false) || identities[0];
    }

    const fromEmail = selectedIdentity.email;

    const mailboxes = await this.getMailboxes();
    const draftsMailbox = mailboxes.find((mb: any) => mb.role === 'drafts') || mailboxes.find((mb: any) => mb.name.toLowerCase().includes('draft'));
    const sentMailbox = mailboxes.find((mb: any) => mb.role === 'sent') || mailboxes.find((mb: any) => mb.name.toLowerCase().includes('sent'));

    if (!draftsMailbox) {
      throw new Error('Could not find Drafts mailbox');
    }
    if (!sentMailbox) {
      throw new Error('Could not find Sent mailbox');
    }

    const initialMailboxId = email.mailboxId || draftsMailbox.id;

    if (!email.textBody && !email.htmlBody) {
      throw new Error('Either textBody or htmlBody must be provided');
    }

    const initialMailboxIds: Record<string, boolean> = {};
    initialMailboxIds[initialMailboxId] = true;

    const sentMailboxIds: Record<string, boolean> = {};
    sentMailboxIds[sentMailbox.id] = true;

    const emailObject = {
      mailboxIds: initialMailboxIds,
      keywords: { $draft: true },
      from: [{ email: fromEmail }],
      to: email.to.map(addr => ({ email: addr })),
      cc: email.cc?.map(addr => ({ email: addr })) || [],
      bcc: email.bcc?.map(addr => ({ email: addr })) || [],
      subject: email.subject,
      textBody: email.textBody ? [{ partId: 'text', type: 'text/plain' }] : undefined,
      htmlBody: email.htmlBody ? [{ partId: 'html', type: 'text/html' }] : undefined,
      bodyValues: {
        ...(email.textBody && { text: { value: email.textBody } }),
        ...(email.htmlBody && { html: { value: email.htmlBody } })
      }
    };

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          create: { draft: emailObject }
        }, 'createEmail'],
        ['EmailSubmission/set', {
          accountId: session.accountId,
          create: {
            submission: {
              emailId: '#draft',
              identityId: selectedIdentity.id,
              envelope: {
                mailFrom: { email: fromEmail },
                rcptTo: email.to.map(addr => ({ email: addr }))
              }
            }
          },
          onSuccessUpdateEmail: {
            '#submission': {
              mailboxIds: sentMailboxIds,
              keywords: { $seen: true }
            }
          }
        }, 'submitEmail']
      ]
    };

    const response = await this.makeRequest(request);

    const emailResult = _extractMethodResponse(response, 0, 'Email/set');
    if (emailResult.notCreated && emailResult.notCreated.draft) {
      throw new Error('Failed to create email. Please check inputs and try again.');
    }

    const submissionResult = _extractMethodResponse(response, 1, 'EmailSubmission/set');
    if (submissionResult.notCreated && submissionResult.notCreated.submission) {
      throw new Error('Failed to submit email. Please try again later.');
    }

    return submissionResult.created?.submission?.id || 'unknown';
  }

  // -------------------------------------------------------------------------
  // Recent emails
  // -------------------------------------------------------------------------

  async getRecentEmails(limit: number = 10, mailboxName: string = 'inbox'): Promise<any[]> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();

    if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
      throw new Error('No mailboxes found in account');
    }

    const targetMailbox = mailboxes.find((mb: any) =>
      mb.role === mailboxName.toLowerCase() ||
      mb.name.toLowerCase().includes(mailboxName.toLowerCase())
    );

    if (!targetMailbox) {
      const available = mailboxes.map((m: any) => `${m.name} (${m.role ?? 'no role'})`).join(', ');
      throw new Error(`Could not find mailbox: ${mailboxName}. Available: ${available}`);
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter: { inMailbox: targetMailbox.id },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: Math.min(limit, 50)
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment', 'keywords']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 1, 'Email/get');
    return result.list ?? [];
  }

  // -------------------------------------------------------------------------
  // Email mutations
  // -------------------------------------------------------------------------

  async markEmailRead(emailId: string, read: boolean = true): Promise<void> {
    const session = await this.getSession();

    const keywords = read ? { $seen: true } : {};

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: { keywords }
          }
        }, 'updateEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error(`Failed to mark email as ${read ? 'read' : 'unread'}.`);
    }
  }

  async deleteEmail(emailId: string): Promise<void> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();
    const trashMailbox = mailboxes.find((mb: any) => mb.role === 'trash') || mailboxes.find((mb: any) => mb.name.toLowerCase().includes('trash'));

    if (!trashMailbox) {
      throw new Error('Could not find Trash mailbox');
    }

    const trashMailboxIds: Record<string, boolean> = {};
    trashMailboxIds[trashMailbox.id] = true;

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: { mailboxIds: trashMailboxIds }
          }
        }, 'moveToTrash']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error('Failed to delete email.');
    }
  }

  async moveEmail(emailId: string, targetMailboxId: string): Promise<void> {
    const session = await this.getSession();

    const targetMailboxIds: Record<string, boolean> = {};
    targetMailboxIds[targetMailboxId] = true;

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: {
            [emailId]: { mailboxIds: targetMailboxIds }
          }
        }, 'moveEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && result.notUpdated[emailId]) {
      throw new Error('Failed to move email.');
    }
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  async getEmailAttachments(emailId: string): Promise<any[]> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments']
        }, 'getAttachments']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/get');
    const email = result.list?.[0];
    return email?.attachments || [];
  }

  async downloadAttachment(emailId: string, attachmentId: string): Promise<string> {
    const session = await this.getSession();

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/get', {
          accountId: session.accountId,
          ids: [emailId],
          properties: ['attachments', 'bodyValues'],
          bodyProperties: ['partId', 'blobId', 'size', 'name', 'type']
        }, 'getEmail']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/get');
    const email = result.list?.[0];

    if (!email) {
      throw new Error('Email not found');
    }

    let attachment = email.attachments?.find((att: any) =>
      att.partId === attachmentId || att.blobId === attachmentId
    );

    if (!attachment && !isNaN(parseInt(attachmentId))) {
      const index = parseInt(attachmentId);
      attachment = email.attachments?.[index];
    }

    if (!attachment) {
      throw new Error('Attachment not found.');
    }

    const downloadUrl = session.downloadUrl;
    if (!downloadUrl) {
      throw new Error('Download capability not available in session');
    }

    const url = downloadUrl
      .replace('{accountId}', session.accountId)
      .replace('{blobId}', attachment.blobId)
      .replace('{type}', encodeURIComponent(attachment.type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(attachment.name || 'attachment'));

    return url;
  }

  // -------------------------------------------------------------------------
  // Advanced search
  // -------------------------------------------------------------------------

  async advancedSearch(filters: {
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    hasAttachment?: boolean;
    isUnread?: boolean;
    mailboxId?: string;
    after?: string;
    before?: string;
    limit?: number;
  }): Promise<any[]> {
    const session = await this.getSession();

    const filter: any = {};

    if (filters.query) filter.text = filters.query;
    if (filters.from) filter.from = filters.from;
    if (filters.to) filter.to = filters.to;
    if (filters.subject) filter.subject = filters.subject;
    if (filters.hasAttachment !== undefined) filter.hasAttachment = filters.hasAttachment;
    if (filters.isUnread !== undefined) filter.hasKeyword = filters.isUnread ? undefined : '$seen';
    if (filters.mailboxId) filter.inMailbox = filters.mailboxId;
    if (filters.after) filter.after = filters.after;
    if (filters.before) filter.before = filters.before;

    if (filters.isUnread === true) {
      filter.notKeyword = '$seen';
      delete filter.hasKeyword;
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: session.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: Math.min(filters.limit || 50, 100)
        }, 'query'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
          properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 1, 'Email/get');
    return result.list ?? [];
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async getThread(threadId: string): Promise<any[]> {
    const session = await this.getSession();

    let actualThreadId = threadId;

    // Try to resolve thread ID from email ID
    try {
      const emailRequest: JmapRequest = {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Email/get', {
            accountId: session.accountId,
            ids: [threadId],
            properties: ['threadId']
          }, 'checkEmail']
        ]
      };

      const emailResponse = await this.makeRequest(emailRequest);
      const emailResult = _extractMethodResponse(emailResponse, 0, 'Email/get');
      const email = emailResult.list?.[0];

      if (email && email.threadId) {
        actualThreadId = email.threadId;
      }
    } catch {
      // If email lookup fails, assume threadId is correct
    }

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Thread/get', {
          accountId: session.accountId,
          ids: [actualThreadId]
        }, 'getThread'],
        ['Email/get', {
          accountId: session.accountId,
          '#ids': { resultOf: 'getThread', name: 'Thread/get', path: '/list/*/emailIds' },
          properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId']
        }, 'emails']
      ]
    };

    const response = await this.makeRequest(request);
    const threadResult = _extractMethodResponse(response, 0, 'Thread/get');

    if (threadResult.notFound && threadResult.notFound.includes(actualThreadId)) {
      throw new Error(`Thread with ID '${actualThreadId}' not found`);
    }

    const emailsResult = _extractMethodResponse(response, 1, 'Email/get');
    return emailsResult.list ?? [];
  }

  // -------------------------------------------------------------------------
  // Stats / Summary
  // -------------------------------------------------------------------------

  async getMailboxStats(mailboxId?: string): Promise<any> {
    const session = await this.getSession();

    if (mailboxId) {
      const request: JmapRequest = {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Mailbox/get', {
            accountId: session.accountId,
            ids: [mailboxId],
            properties: ['id', 'name', 'role', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']
          }, 'mailbox']
        ]
      };

      const response = await this.makeRequest(request);
      const result = _extractMethodResponse(response, 0, 'Mailbox/get');
      return result.list?.[0] ?? null;
    } else {
      const mailboxes = await this.getMailboxes();
      return mailboxes.map((mb: any) => ({
        id: mb.id,
        name: mb.name,
        role: mb.role,
        totalEmails: mb.totalEmails || 0,
        unreadEmails: mb.unreadEmails || 0,
        totalThreads: mb.totalThreads || 0,
        unreadThreads: mb.unreadThreads || 0
      }));
    }
  }

  async getAccountSummary(): Promise<any> {
    const session = await this.getSession();
    const mailboxes = await this.getMailboxes();
    const identities = await this.getIdentities();

    const totals = mailboxes.reduce((acc: any, mb: any) => ({
      totalEmails: acc.totalEmails + (mb.totalEmails || 0),
      unreadEmails: acc.unreadEmails + (mb.unreadEmails || 0),
      totalThreads: acc.totalThreads + (mb.totalThreads || 0),
      unreadThreads: acc.unreadThreads + (mb.unreadThreads || 0)
    }), { totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 });

    return {
      accountId: session.accountId,
      mailboxCount: mailboxes.length,
      identityCount: identities.length,
      ...totals,
      mailboxes: mailboxes.map((mb: any) => ({
        id: mb.id,
        name: mb.name,
        role: mb.role,
        totalEmails: mb.totalEmails || 0,
        unreadEmails: mb.unreadEmails || 0
      }))
    };
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  async bulkMarkRead(emailIds: string[], read: boolean = true): Promise<void> {
    const session = await this.getSession();

    const keywords = read ? { $seen: true } : {};
    const updates: Record<string, any> = {};

    emailIds.forEach(id => {
      updates[id] = { keywords };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkUpdate']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to update some emails.');
    }
  }

  async bulkMove(emailIds: string[], targetMailboxId: string): Promise<void> {
    const session = await this.getSession();

    const targetMailboxIds: Record<string, boolean> = {};
    targetMailboxIds[targetMailboxId] = true;

    const updates: Record<string, any> = {};
    emailIds.forEach(id => {
      updates[id] = { mailboxIds: targetMailboxIds };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkMove']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to move some emails.');
    }
  }

  async bulkDelete(emailIds: string[]): Promise<void> {
    const session = await this.getSession();

    const mailboxes = await this.getMailboxes();
    const trashMailbox = mailboxes.find((mb: any) => mb.role === 'trash') || mailboxes.find((mb: any) => mb.name.toLowerCase().includes('trash'));

    if (!trashMailbox) {
      throw new Error('Could not find Trash mailbox');
    }

    const trashMailboxIds: Record<string, boolean> = {};
    trashMailboxIds[trashMailbox.id] = true;

    const updates: Record<string, any> = {};
    emailIds.forEach(id => {
      updates[id] = { mailboxIds: trashMailboxIds };
    });

    const request: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/set', {
          accountId: session.accountId,
          update: updates
        }, 'bulkDelete']
      ]
    };

    const response = await this.makeRequest(request);
    const result = _extractMethodResponse(response, 0, 'Email/set');

    if (result.notUpdated && Object.keys(result.notUpdated).length > 0) {
      throw new Error('Failed to delete some emails.');
    }
  }
}
