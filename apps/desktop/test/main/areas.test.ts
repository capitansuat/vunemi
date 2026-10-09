import { describe, expect, it } from "vitest";
import { toolAreas } from "../../src/main/areas.js";

describe("toolAreas", () => {
  it("gives each working connection a line for the model and its guide, and app groups behind app_guide", () => {
    const areas = toolAreas([
      { id: "mail", label: "Posta", instructions: "Mail guide." },
      { id: "reminders", label: "Anımsatıcılar" },
      { id: "automations", label: "Otomasyonlar", instructions: "Scheduled tasks." },
      { id: "history", label: "Geçmiş", instructions: "Earlier conversations." },
      { id: "mcp-weather", label: "Hava durumu" },
    ], [{ id: "music", covers: "what is playing; play a song", guide: "Music guide." }]);
    expect(areas).toEqual([
      { id: "mail", summary: "the user's mailbox: find, read, draft, send, organize emails", guide: "Mail guide." },
      { id: "reminders", summary: "the user's reminders" },
      { id: "automations", summary: "tasks that run later or repeatedly on a schedule", guide: "Scheduled tasks.", alwaysShown: ["automation_create"] },
      { id: "history", summary: "the user's earlier conversations with you and their recorded meetings", guide: "Earlier conversations.", alwaysShown: ["library_search", "library_open"] },
      { id: "mcp-weather", summary: "Hava durumu" },
      { id: "music", summary: "what is playing; play a song", guide: "Music guide.", routed: false },
    ]);
  });
});
