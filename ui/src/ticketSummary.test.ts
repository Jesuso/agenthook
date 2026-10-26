import { describe, it, expect } from "vitest";
import { summaryRequest, summaryText } from "./ticketSummary";

describe("ticket summary requests", () => {
  it("posts profile, ref and the UI language with the write guard header", () => {
    const { url, init } = summaryRequest("dev", "42", "es");
    expect(url).toBe("/api/summary");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-AH-UI"]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ profile: "dev", ref: "42", lang: "es" });
  });
  it("takes the text only from a 200 with text; anything else keeps the regex summary", () => {
    expect(summaryText(200, { text: " Arreglar el login. " })).toBe("Arreglar el login.");
    expect(summaryText(200, { text: null })).toBeNull();
    expect(summaryText(200, { text: "  " })).toBeNull();
    expect(summaryText(502, { error: "not assigned to us" })).toBeNull();
    expect(summaryText(503, null)).toBeNull();
    expect(summaryText(0, null)).toBeNull();
  });
});
