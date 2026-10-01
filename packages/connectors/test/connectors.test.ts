/**
 * Connections. The claim worth testing is the strong one: a connection the
 * user switched off does not merely disappear from a menu — the model
 * cannot call its tools by name either.
 */
import { ToolRegistry, toolSpecsOf, type ToolDef } from "@vunemi/agent-core";
import { describe, expect, it } from "vitest";
import { Connectors, type Connector, type ConnectorStatus } from "../src/index.js";

const tool = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  actionClass: "read",
  run: async () => "ok",
});

function fake(id: string, over: Partial<Connector> = {}): Connector {
  return {
    id,
    label: id,
    description: `${id} açıklaması`,
    provides: ["bir şey"],
    needs: { kind: "none" },
    defaultOn: true,
    origin: "builtin",
    group: "service",
    status: async (): Promise<ConnectorStatus> => ({ state: "ready" }),
    tools: () => [tool(`${id}_oku`), tool(`${id}_yaz`)],
    ...over,
  };
}

describe("switching a connection off", () => {
  it("takes its tools out of the model's reach, by name as well as from the list", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(fake("takvim"));
    connectors.add(fake("dosyalar"));

    expect(tools.list().map((t) => t.name)).toContain("takvim_oku");

    connectors.setOn("takvim", false);
    expect(tools.list().map((t) => t.name)).not.toContain("takvim_oku");
    // The part that matters: remembering the name does not help.
    expect(tools.get("takvim_oku")).toBeUndefined();
    // And the other connection is untouched.
    expect(tools.get("dosyalar_oku")).toBeDefined();
  });

  it("puts them back when it is switched on again", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(fake("takvim"));

    connectors.setOn("takvim", false);
    connectors.setOn("takvim", true);
    expect(tools.get("takvim_oku")).toBeDefined();
  });
});

describe("what starts on", () => {
  it("offers a built-in travel search for one approval while it remains off", () => {
    const tools = new ToolRegistry();
    const saved: Record<string, boolean>[] = [];
    const connectors = new Connectors({ tools, onChange: (state) => saved.push(state) });
    connectors.add(fake("travel-hotels", { defaultOn: false, requestableWhenOff: true,
      tools: () => [tool("travel_search_hotels")] }));
    expect(connectors.isOn("travel-hotels")).toBe(false);
    expect(tools.get("travel_search_hotels")).toBeUndefined();
    expect(connectors.partOf("travel_search_hotels")?.label).toBe("travel-hotels");
    expect(toolSpecsOf(tools, undefined, (name) => connectors.partOf(name) !== null, "İzmir'de yarın otel bak"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "travel_search_hotels" })]));
    expect(connectors.instructions()).toContain("call travel_search_flights or travel_search_hotels first");
    expect(connectors.instructions()).not.toContain("not switched on: travel-hotels");
    expect(saved).toEqual([]); // A one-time approval need not change the switch.
    connectors.switchOnFor("travel_search_hotels");
    expect(connectors.isOn("travel-hotels")).toBe(true);
    expect(tools.get("travel_search_hotels")).toBeDefined();
    expect(saved.at(-1)).toEqual({ "travel-hotels": true });
  });

  it("honours each connection's own default", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(fake("tarayıcı", { defaultOn: true }));
    connectors.add(fake("posta", { defaultOn: false }));

    expect(tools.get("tarayıcı_oku")).toBeDefined();
    // Anything reaching an account starts off and is turned on deliberately.
    expect(tools.get("posta_oku")).toBeUndefined();
  });

  it("remembers what the user chose last time", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools, remembered: { posta: true, takvim: false } });
    connectors.add(fake("posta", { defaultOn: false }));
    connectors.add(fake("takvim", { defaultOn: true }));

    expect(tools.get("posta_oku")).toBeDefined();
    expect(tools.get("takvim_oku")).toBeUndefined();
  });

  it("hands the choice back so it can be written down", () => {
    const saved: Record<string, boolean>[] = [];
    const connectors = new Connectors({ tools: new ToolRegistry(), onChange: (s) => saved.push(s) });
    connectors.add(fake("posta", { defaultOn: false }));

    connectors.setOn("posta", true);
    expect(saved.at(-1)).toEqual({ posta: true });
  });
});

describe("the connections screen", () => {
  it("says off without asking the connection anything", async () => {
    let asked = 0;
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(
      fake("takvim", {
        defaultOn: false,
        status: async () => {
          asked++;
          return { state: "ready" };
        },
      }),
    );

    const [row] = await connectors.list();
    expect(row?.status).toEqual({ state: "off" });
    // Nothing prompts macOS about a permission the user has switched away.
    expect(asked).toBe(0);
  });

  it("carries which half of the screen each one belongs to", async () => {
    // The view is assembled field by field, so a field added to the type
    // and forgotten there vanishes silently and the screen quietly puts
    // every connection in one group again.
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(fake("dosyalar", { group: "computer" }));
    connectors.add(fake("takvim", { group: "service" }));

    const rows = await connectors.list();
    expect(rows.map((row) => [row.id, row.group])).toEqual([
      ["dosyalar", "computer"],
      ["takvim", "service"],
    ]);
  });

  it("reports what the user must do rather than a bare failure", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(
      fake("takvim", {
        status: async () => ({ state: "blocked", reason: "Sistem Ayarları › Takvim" }),
      }),
    );

    const [row] = await connectors.list();
    expect(row?.status).toMatchObject({ state: "blocked", reason: /Sistem Ayarları/ });
  });

  it("turns a probe that throws into a state, not a crashed screen", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(fake("posta", { status: async () => { throw new Error("sunucuya ulaşılamadı"); } }));

    const [row] = await connectors.list();
    expect(row?.status).toEqual({ state: "blocked", reason: "sunucuya ulaşılamadı" });
  });

  it("says which ones can be signed into from here", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(fake("takvim"));
    connectors.add(fake("posta", { connect: async () => ({ state: "ready", account: "test@example.com" }) }));

    const rows = await connectors.list();
    expect(rows.find((r) => r.id === "takvim")?.connectable).toBe(false);
    expect(rows.find((r) => r.id === "posta")?.connectable).toBe(true);
  });
});

describe("a macOS permission already given", () => {
  it("is reported for a connection that is off, so the screen can offer to turn it on", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    const permission = (granted: boolean): Partial<Connector> => ({
      defaultOn: false,
      needs: { kind: "permission", what: "Accessibility" },
      connect: async () => ({ state: "ready" }),
      status: async () => (granted ? { state: "ready" } : { state: "blocked", reason: "no" }),
    });
    connectors.add(fake("masaustu", permission(true)));
    connectors.add(fake("takvim", permission(false)));
    connectors.add(fake("posta", { defaultOn: false, connect: async () => ({ state: "ready" }), status: async () => { throw new Error("must not be asked"); } }));

    const rows = await connectors.list();
    expect(rows.find((r) => r.id === "masaustu")).toMatchObject({ status: { state: "off" }, permitted: true });
    expect(rows.find((r) => r.id === "takvim")?.permitted).toBe(false);
    expect(rows.find((r) => r.id === "takvim")?.permissionStatus).toEqual({ state: "blocked", reason: "no" });
    expect(rows.find((r) => r.id === "posta")?.permitted).toBeUndefined();
  });
});

describe("permission-gated activation", () => {
  it("keeps Desktop and its Control tools off when the live permission is blocked", async () => {
    const tools = new ToolRegistry();
    let ready = false;
    const connectors = new Connectors({ tools });
    connectors.add(fake("desktop", {
      defaultOn: false,
      needs: { kind: "permission", what: "Accessibility" },
      capabilities: [
        { id: "see", label: "See", tools: ["desktop_oku"], defaultOn: true },
        { id: "act", label: "Control", tools: ["desktop_yaz"], defaultOn: false },
      ],
      status: async () => ready ? { state: "ready" } : { state: "blocked", reason: "Accessibility denied", settings: "accessibility" },
      connect: async () => ready ? { state: "ready" } : { state: "blocked", reason: "Accessibility denied" },
    }));

    const [off] = await connectors.list();
    expect(off?.status).toEqual({ state: "off" });
    expect(off?.permissionStatus).toMatchObject({ state: "blocked", settings: "accessibility" });
    await expect(connectors.setOnIfReady("desktop")).rejects.toThrow("Accessibility denied");
    expect(connectors.isOn("desktop")).toBe(false);
    expect(connectors.onIds()).not.toContain("desktop");
    expect(tools.get("desktop_yaz")).toBeUndefined();

    ready = true;
    await connectors.setOnIfReady("desktop");
    expect(connectors.isOn("desktop")).toBe(true);
    expect(connectors.onIds()).toContain("desktop");
    expect(tools.get("desktop_yaz")).toBeUndefined();
    connectors.setPartOn("desktop", "act", true);
    expect(tools.get("desktop_yaz")).toBeDefined();
  });
});

describe("connecting and disconnecting", () => {
  it("switches a connection on as part of authorising it", async () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(
      fake("posta", { defaultOn: false, connect: async () => ({ state: "ready", account: "test@example.com" }) }),
    );

    expect(tools.get("posta_oku")).toBeUndefined();
    const status = await connectors.connect("posta");
    expect(status).toMatchObject({ account: "test@example.com" });
    expect(tools.get("posta_oku")).toBeDefined();
  });

  it("leaves it off when authorising did not work", async () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(fake("posta", { defaultOn: false, connect: async () => ({ state: "blocked", reason: "iptal edildi" }) }));

    await connectors.connect("posta");
    expect(tools.get("posta_oku")).toBeUndefined();
  });

  it("forgets the account and switches off when disconnected", async () => {
    const tools = new ToolRegistry();
    let forgotten = false;
    const connectors = new Connectors({ tools });
    connectors.add(
      fake("posta", {
        connect: async () => ({ state: "ready" }),
        disconnect: async () => {
          forgotten = true;
        },
      }),
    );

    await connectors.disconnect("posta");
    expect(forgotten).toBe(true);
    expect(tools.get("posta_oku")).toBeUndefined();
  });

  it("will not pretend about a connection it does not have", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    expect(() => connectors.setOn("yok", true)).toThrow(/No such connector/);
    await expect(connectors.connect("yok")).rejects.toThrow(/No such connector/);
  });
});

describe("what the model is told", () => {
  it("describes only the connections that are on", () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(fake("takvim", { instructions: "Takvimi şöyle kullan." }));
    connectors.add(fake("posta", { defaultOn: false, instructions: "Postayı şöyle kullan." }));

    expect(connectors.instructions()).toMatch(/^Takvimi şöyle kullan\./);
    expect(connectors.instructions()).not.toContain("Postayı");
    // Named, so "what can you do?" covers it, but its guide stays out.
    expect(connectors.instructions()).toMatch(/not switched on: posta\. None of them can be used until .*Settings › Connections/);

    connectors.setOn("posta", true);
    expect(connectors.instructions()).toContain("Postayı şöyle kullan.");
    expect(connectors.instructions()).not.toContain("not switched on");
  });

  it("says which tools of an open connection are switched off", () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(fake("takvim", {
      instructions: "Takvimi şöyle kullan.",
      capabilities: [
        { id: "read", label: "Read", tools: ["takvim_oku"], defaultOn: true },
        { id: "write", label: "Add", tools: ["takvim_yaz"], defaultOn: false },
      ],
    }));
    expect(connectors.instructions()).toMatch(/Switched off by the user: takvim_yaz\. If the task needs one, call it anyway/);
    expect(connectors.partOf("takvim_yaz")).toEqual({ connectorId: "takvim", partId: "write", label: "takvim › Add" });
    expect(connectors.partOf("takvim_oku")).toBeNull();
    connectors.setPartOn("takvim", "write", true);
    expect(connectors.instructions()).toBe("Takvimi şöyle kullan.");
  });
});

describe("connections the user added themselves", () => {
  it("takes one out completely when it is removed", async () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(fake("mcp-sunucu"));
    connectors.add(fake("takvim"));

    connectors.remove("mcp-sunucu");
    expect(tools.get("mcp-sunucu_oku")).toBeUndefined();
    expect((await connectors.list()).map((r) => r.id)).toEqual(["takvim"]);
    // Removed, not merely switched off: adding it again must be possible.
    expect(() => connectors.add(fake("mcp-sunucu"))).not.toThrow();
  });

  it("swaps one for its new self and keeps it on or off as the user left it", async () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools, remembered: { "mcp-sunucu": false } });
    connectors.add(fake("mcp-sunucu", { tools: () => [tool("eski_oku")] }));
    connectors.replace(fake("mcp-sunucu", { tools: () => [tool("yeni_oku")] }));
    expect(tools.get("eski_oku")).toBeUndefined();
    expect(tools.get("yeni_oku")).toBeUndefined(); // still off
    expect(connectors.isOn("mcp-sunucu")).toBe(false);
    connectors.setOn("mcp-sunucu", true);
    expect(tools.get("yeni_oku")).toBeDefined();
    expect(tools.get("eski_oku")).toBeUndefined();
  });

  it("picks up tools that only appear after connecting", async () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    let known: string[] = [];
    connectors.add(
      fake("mcp-sunucu", {
        tools: () => known.map((name) => tool(name)),
        connect: async () => {
          known = ["mcp_ara", "mcp_gonder"];
          return { state: "ready" };
        },
      }),
    );

    // A server says nothing about itself until it is asked.
    expect(tools.list()).toEqual([]);
    await connectors.connect("mcp-sunucu");
    expect(tools.list().map((t) => t.name)).toEqual(["mcp_ara", "mcp_gonder"]);
  });
});

describe("the parts of a connection", () => {
  const withParts = () =>
    fake("dosyalar", {
      tools: () => [tool("files_read"), tool("files_write"), tool("system_run")],
      capabilities: [
        { id: "read", label: "Okuma", tools: ["files_read"], defaultOn: true },
        { id: "write", label: "Yazma", tools: ["files_write"], defaultOn: false },
        { id: "convert", label: "Dönüştürme", tools: ["system_run"], defaultOn: false },
      ],
    });

  it("gives each part its own default, so 'files' is not one permission", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(withParts());

    // Switching the connection on does not hand over writing and converting.
    expect(tools.get("files_read")).toBeDefined();
    expect(tools.get("files_write")).toBeUndefined();
    expect(tools.get("system_run")).toBeUndefined();
  });

  it("switches one part without disturbing the others", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(withParts());

    connectors.setPartOn("dosyalar", "write", true);
    expect(tools.get("files_write")).toBeDefined();
    expect(tools.get("system_run")).toBeUndefined();
    expect(tools.get("files_read")).toBeDefined();
  });

  it("takes every part with it when the connection goes off", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools });
    connectors.add(withParts());
    connectors.setPartOn("dosyalar", "write", true);

    connectors.setOn("dosyalar", false);
    expect(tools.list()).toEqual([]);

    // And switching it back on restores what the user chose, not the defaults.
    connectors.setOn("dosyalar", true);
    expect(tools.get("files_write")).toBeDefined();
    expect(tools.get("system_run")).toBeUndefined();
  });

  it("remembers each part separately between runs", () => {
    const tools = new ToolRegistry();
    const connectors = new Connectors({ tools, remembered: { "dosyalar:convert": true, "dosyalar:read": false } });
    connectors.add(withParts());

    expect(tools.get("system_run")).toBeDefined();
    expect(tools.get("files_read")).toBeUndefined();
  });

  it("shows the parts and their state on the connections screen", async () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(withParts());

    const [row] = await connectors.list();
    expect(row?.parts).toEqual([
      { id: "read", label: "Okuma", tools: 1, on: true },
      { id: "write", label: "Yazma", tools: 1, on: false },
      { id: "convert", label: "Dönüştürme", tools: 1, on: false },
    ]);
  });

  it("refuses a part it does not have rather than inventing one", () => {
    const connectors = new Connectors({ tools: new ToolRegistry() });
    connectors.add(withParts());
    expect(() => connectors.setPartOn("dosyalar", "silme", true)).toThrow(/No such part/);
  });
});

describe("parts", () => {
  it("won't take a tool that belongs to none of a connection's parts", () => {
    // Its source would be one nothing switches, so it would work with the connection off.
    const connectors = new Connectors({ tools: new ToolRegistry() });
    expect(() =>
      connectors.add(fake("files", { defaultOn: false, capabilities: [{ id: "read", label: "Read", tools: ["files_oku"], defaultOn: true }] })),
    ).toThrow(/files_yaz/);
  });
});
