import { createElement } from "lwc";
import SafeMetadataDelete from "c/safeMetadataDelete";

const flushPromises = () =>
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());

describe("c-safe-metadata-delete", () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.restoreAllMocks();
    delete global.fetch;
  });

  it("clears the fetched plan and command when Cancel is clicked", async () => {
    const element = createElement("c-safe-metadata-delete", {
      is: SafeMetadataDelete
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runId: "run-1",
        status: "awaiting_approval",
        targets: [],
        blocked: [],
        diffs: []
      })
    });
    global.fetch = fetchMock;
    document.body.appendChild(element);

    const textarea = element.shadowRoot.querySelector("lightning-textarea");
    textarea.value = "Delete Legacy_Field__c from Account";
    textarea.dispatchEvent(new CustomEvent("change"));
    await flushPromises();
    const buttons = element.shadowRoot.querySelectorAll("lightning-button");
    buttons[1].click();
    await flushPromises();
    await flushPromises();

    const cancel = [...element.shadowRoot.querySelectorAll("lightning-button")].find(
      (button) => button.label === "Cancel"
    );
    expect(cancel).not.toBeUndefined();
    cancel.click();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.shadowRoot.querySelector("section")).toBeNull();
    expect(textarea.value).toBe("");
  });
});
