import { LightningElement, api } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";

export default class SafeMetadataDelete extends LightningElement {
  @api backendUrl = "http://localhost:3001";
  @api apiToken = "";
  command = ""; plan; busy = false; listening = false; error = ""; approvalChecked = false; recognition;
  get hasPlan() { return Boolean(this.plan); }
  get hasBlocked() { return Boolean(this.plan?.blocked?.length); }
  get hasDiffs() { return Boolean(this.plan?.diffs?.length); }
  get canApprove() { return this.plan?.status === "awaiting_approval"; }
  get canRollback() { return this.plan?.status === "failed"; }
  get analyzeDisabled() { return this.busy || !this.command.trim(); }
  get approveDisabled() { return this.busy || !this.approvalChecked; }
  get micLabel() { return this.listening ? "Stop listening" : "Speak command"; }
  get micDisabled() { return this.busy || (typeof window !== "undefined" && !("SpeechRecognition" in window) && !("webkitSpeechRecognition" in window)); }
  get targetViews() {
    return (this.plan?.targets || []).map((target) => ({
      ...target, isObject: target.targetType === "object",
      manualReview: (target.manualReview || []).map((item) => ({ ...item, key: `${item.type}:${item.name}` })),
      incomingRelationships: (target.incomingRelationships || []).map((item) => ({ ...item, key: `${item.objectApiName}.${item.fieldApiName}` })),
    }));
  }
  workspaceToastMessage(workspaceSync) {
    if (!workspaceSync?.connected) {
      return "Validation, fixes, and destructive deployment succeeded.";
    }
    if (workspaceSync.error) {
      return "Deployment succeeded, but metadata could not be copied to the local project.";
    }
    const synced = workspaceSync.synced?.length || 0;
    const skipped = workspaceSync.skipped?.length || 0;
    return `Deployment succeeded. ${synced} metadata file(s) copied to the local project${skipped ? `; ${skipped} conflicting file(s) skipped` : ""}.`;
  }
  disconnectedCallback() { this.recognition?.abort(); }
  handleCommand(event) { this.command = event.target.value; }
  handleApprovalCheck(event) { this.approvalChecked = event.target.checked; }
  toggleListening() {
    if (this.listening) { this.recognition?.stop(); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { this.error = "Speech recognition is not supported by this browser. Use text input."; return; }
    this.recognition = new Recognition();
    this.recognition.lang = navigator.language || "en-US"; this.recognition.interimResults = true; this.recognition.continuous = false;
    this.recognition.onstart = () => { this.listening = true; this.error = ""; };
    this.recognition.onresult = (event) => { this.command = Array.from(event.results).map((result) => result[0].transcript).join(" "); };
    this.recognition.onerror = (event) => { this.error = `Microphone error: ${event.error}`; };
    this.recognition.onend = () => { this.listening = false; };
    this.recognition.start();
  }
  async request(route, body) {
    const headers = { "Content-Type": "application/json" };
    if (this.apiToken) headers["X-Backend-Token"] = this.apiToken;
    const response = await fetch(`${this.backendUrl.replace(/\/$/, "")}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || `Backend returned ${response.status}`); error.details = result.details; throw error; }
    return result;
  }
  async analyze() {
    this.busy = true; this.error = ""; this.plan = undefined; this.approvalChecked = false;
    try { this.plan = await this.request("/api/plan", { command: this.command.trim() }); }
    catch (error) { this.error = this.formatError(error); } finally { this.busy = false; }
  }
  async approve() {
    this.busy = true; this.error = "";
    try {
      const result = await this.request(`/api/runs/${this.plan.runId}/approve`, { approvalToken: this.plan.approvalToken, confirmed: true });
      this.plan = { ...this.plan, ...result }; this.toast("Deletion completed", "Validation, fixes, and destructive deployment succeeded.", "success");
    } catch (error) { this.error = this.formatError(error); this.plan = { ...this.plan, status: "failed" }; } finally { this.busy = false; }
  }
  async rollback() {
    this.busy = true; this.error = "";
    try {
      const result = await this.request(`/api/runs/${this.plan.runId}/rollback`, { approvalToken: this.plan.approvalToken, confirmed: true });
      this.plan = { ...this.plan, ...result }; this.toast("Rollback completed", "Backed-up metadata was redeployed.", "success");
    } catch (error) { this.error = this.formatError(error); } finally { this.busy = false; }
  }
  formatError(error) { return `${error.message}${error.details?.command ? ` (${error.details.command})` : ""}`; }
  toast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
}
