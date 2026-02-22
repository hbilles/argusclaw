/**
 * SecureClaw Dashboard — Alpine.js application.
 * Chat interface with admin panel sidebar.
 */

document.addEventListener('alpine:init', () => {
  Alpine.data('secureclaw', () => ({
    // UI state
    activePanel: 'chat',
    sidebarOpen: true,

    // Chat state
    messages: [],
    inputText: '',
    isThinking: false,
    _msgId: 0,

    // Approval state
    pendingApprovals: [],

    // Admin panel data
    auditEntries: [],
    auditDate: new Date().toISOString().split('T')[0],
    auditType: '',
    memoriesGrouped: {},
    sessionsList: [],
    approvalsList: [],
    configText: '',

    // SSE
    _eventSource: null,

    // ------------------------------------------------------------------
    // Initialization
    // ------------------------------------------------------------------

    init() {
      this.loadChatHistory();
      this.connectSSE();
    },

    // ------------------------------------------------------------------
    // SSE — global audit/approval stream
    // ------------------------------------------------------------------

    connectSSE() {
      this._eventSource = new EventSource('/api/audit/stream');

      this._eventSource.addEventListener('audit', (e) => {
        const entry = JSON.parse(e.data);
        if (this.activePanel === 'audit') {
          this.auditEntries.unshift(entry);
          // Keep a reasonable number
          if (this.auditEntries.length > 500) {
            this.auditEntries.length = 500;
          }
        }
      });

      this._eventSource.addEventListener('approval-request', (e) => {
        const req = JSON.parse(e.data);
        this.pendingApprovals.push(req);

        // If in chat, add approval to message stream
        if (this.activePanel === 'chat') {
          this.messages.push({
            id: this._nextId(),
            type: 'approval',
            role: 'system',
            approvalId: req.approvalId,
            toolName: req.toolName,
            toolInput: req.toolInput,
            reason: req.reason,
            status: 'pending',
            expanded: false,
            inputExpanded: false,
          });
          this._scrollToBottom();
        }
      });

      this._eventSource.addEventListener('approval-expired', (e) => {
        const data = JSON.parse(e.data);
        this._updateApprovalStatus(data.approvalId, 'expired');
      });

      this._eventSource.addEventListener('notification', (e) => {
        const data = JSON.parse(e.data);
        // Show notification as system message in chat
        if (this.activePanel === 'chat' && data.text) {
          this.messages.push({
            id: this._nextId(),
            type: 'text',
            role: 'assistant',
            content: data.text,
          });
          this._scrollToBottom();
        }
      });

      this._eventSource.onerror = () => {
        // Will auto-reconnect
      };
    },

    // ------------------------------------------------------------------
    // Chat
    // ------------------------------------------------------------------

    async sendMessage() {
      const content = this.inputText.trim();
      if (!content || this.isThinking) return;

      this.inputText = '';
      this.isThinking = true;

      // Add user message
      this.messages.push({
        id: this._nextId(),
        role: 'user',
        type: 'text',
        content,
      });
      this._scrollToBottom();

      // Reset textarea height
      if (this.$refs.chatInput) {
        this.$refs.chatInput.style.height = 'auto';
      }

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });

        if (!response.ok && response.status === 409) {
          this.messages.push({
            id: this._nextId(),
            role: 'system',
            type: 'error',
            content: 'A message is already being processed. Please wait.',
          });
          this.isThinking = false;
          return;
        }

        // Read SSE stream from POST response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastEventType = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              lastEventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                this._handleChatEvent(lastEventType, data);
              } catch {
                // Malformed JSON — skip
              }
            }
          }
        }
      } catch (err) {
        this.messages.push({
          id: this._nextId(),
          role: 'system',
          type: 'error',
          content: 'Connection error. Please try again.',
        });
      } finally {
        this.isThinking = false;
        this._scrollToBottom();
      }
    },

    _handleChatEvent(event, data) {
      switch (event) {
        case 'chat:tool_call':
          this.messages.push({
            id: this._nextId(),
            type: 'tool_call',
            role: 'system',
            toolName: data.toolName || data.tool || '',
            toolInput: data.input || data.args || data,
            expanded: false,
          });
          break;

        case 'chat:tool_result':
          this.messages.push({
            id: this._nextId(),
            type: 'tool_result',
            role: 'system',
            toolName: data.toolName || data.tool || '',
            success: data.success !== false,
            content: data.error || '',
          });
          break;

        case 'chat:approval_request':
          this.messages.push({
            id: this._nextId(),
            type: 'approval',
            role: 'system',
            approvalId: data.approvalId,
            toolName: data.toolName || '',
            toolInput: data.toolInput || data.input || {},
            reason: data.reason || '',
            status: 'pending',
            expanded: false,
            inputExpanded: false,
          });
          this.pendingApprovals.push(data);
          break;

        case 'chat:approval_resolved':
          this._updateApprovalStatus(
            data.approvalId,
            data.decision || data.status || 'approved',
          );
          break;

        case 'chat:message':
          this.messages.push({
            id: this._nextId(),
            role: data.role || 'assistant',
            type: 'text',
            content: data.content || '',
          });
          break;

        case 'chat:error':
          this.messages.push({
            id: this._nextId(),
            role: 'system',
            type: 'error',
            content: data.error || 'An error occurred',
          });
          break;

        case 'chat:thinking':
        case 'chat:done':
          // No visual action needed
          break;
      }
      this._scrollToBottom();
    },

    async decide(approvalId, decision) {
      try {
        await fetch('/api/approvals/' + approvalId + '/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        this._updateApprovalStatus(approvalId, decision);
      } catch {
        // Failed to send decision
      }
    },

    _updateApprovalStatus(approvalId, status) {
      const msg = this.messages.find(
        (m) => m.type === 'approval' && m.approvalId === approvalId,
      );
      if (msg) msg.status = status;
      this.pendingApprovals = this.pendingApprovals.filter(
        (a) => a.approvalId !== approvalId,
      );
    },

    async resetChat() {
      try {
        await fetch('/api/chat/reset', { method: 'POST' });
        this.messages = [];
        this.activePanel = 'chat';
      } catch {
        // Ignore
      }
    },

    async loadChatHistory() {
      try {
        const res = await fetch('/api/chat/history');
        const { messages } = await res.json();
        if (messages && messages.length > 0) {
          this.messages = messages.map((m) => ({
            id: this._nextId(),
            role: m.role,
            type: 'text',
            content: m.content,
          }));
          this.$nextTick(() => this._scrollToBottom());
        }
      } catch {
        // First load — no history
      }
    },

    // ------------------------------------------------------------------
    // Admin panels
    // ------------------------------------------------------------------

    switchPanel(name) {
      this.activePanel = name;
      if (name === 'audit') this.loadAudit();
      else if (name === 'memories') this.loadMemories();
      else if (name === 'sessions') this.loadSessions();
      else if (name === 'approvals') this.loadApprovals();
      else if (name === 'config') this.loadConfig();
    },

    async loadAudit() {
      try {
        let url = '/api/audit?date=' + this.auditDate;
        if (this.auditType) url += '&type=' + this.auditType;
        const res = await fetch(url);
        this.auditEntries = (await res.json()).map((e) => ({ ...e, _expanded: false }));
      } catch {
        this.auditEntries = [];
      }
    },

    async loadMemories() {
      try {
        const res = await fetch('/api/memories');
        const memories = await res.json();
        const grouped = {};
        for (const m of memories) {
          (grouped[m.category] = grouped[m.category] || []).push(m);
        }
        this.memoriesGrouped = grouped;
      } catch {
        this.memoriesGrouped = {};
      }
    },

    async loadSessions() {
      try {
        const res = await fetch('/api/sessions');
        this.sessionsList = await res.json();
      } catch {
        this.sessionsList = [];
      }
    },

    async loadApprovals() {
      try {
        const res = await fetch('/api/approvals');
        this.approvalsList = await res.json();
      } catch {
        this.approvalsList = [];
      }
    },

    async loadConfig() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        this.configText = JSON.stringify(data, null, 2);
      } catch {
        this.configText = 'Failed to load configuration';
      }
    },

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _nextId() {
      return ++this._msgId;
    },

    _scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.chatMessages;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    renderMarkdown(text) {
      if (typeof window.simpleMarkdown === 'function') {
        return window.simpleMarkdown(text || '');
      }
      // Fallback: escape HTML and preserve line breaks
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    },

    autoResize(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    },

    getTypeColor(type) {
      const colors = {
        message_received: 'blue',
        llm_request: 'purple',
        llm_response: 'purple',
        tool_call: 'yellow',
        tool_result: 'green',
        action_classified: 'gray',
        approval_requested: 'red',
        approval_resolved: 'green',
        message_sent: 'blue',
        error: 'red',
        mcp_proxy: 'gray',
        mcp_tool_call: 'yellow',
      };
      return colors[type] || 'gray';
    },

    getApprovalColor(status) {
      if (status === 'approved' || status === 'session-approved') return 'green';
      if (status === 'rejected') return 'red';
      if (status === 'pending') return 'yellow';
      return 'gray';
    },
  }));
});
