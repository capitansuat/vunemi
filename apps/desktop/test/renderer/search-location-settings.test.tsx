import { expect, it, vi } from "vitest";
import { setLocale, t } from "@vunemi/i18n";
import { SearchLocationSettings } from "../../src/renderer/src/components/SettingsView.js";

const env = vi.hoisted(() => ({
  locale: "en",
  values: [] as any[],
  refs: [] as any[],
  stateIndex: 0,
  refIndex: 0,
  effects: [] as Array<() => unknown>,
}));

vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useState: (initial: any) => {
    const index = env.stateIndex++;
    if (!(index in env.values)) env.values[index] = initial;
    return [env.values[index], (next: any) => {
      env.values[index] = typeof next === "function" ? next(env.values[index]) : next;
    }];
  },
  useRef: (initial: any) => {
    const index = env.refIndex++;
    return env.refs[index] ?? (env.refs[index] = { current: initial });
  },
  useEffect: (effect: () => unknown) => { env.effects.push(effect); },
}));
vi.mock("../../src/renderer/src/store.js", () => ({
  useStore: (selector: any) => selector({ locale: env.locale }),
}));

function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}

function render() {
  env.stateIndex = 0;
  env.refIndex = 0;
  return nodes(SearchLocationSettings());
}

async function setup(profile = { country: null as string | null, city: null as string | null }) {
  env.values = [];
  env.refs = [];
  env.effects = [];
  env.locale = "en";
  setLocale("en");
  const api = {
    searchLocation: vi.fn(async () => profile),
    setSearchLocation: vi.fn(async (value: any) => value),
  };
  vi.stubGlobal("window", { vunemi: api });
  render();
  const cleanup = env.effects[0]!();
  await Promise.resolve();
  await Promise.resolve();
  return { api, cleanup: cleanup as () => void };
}

function fields() {
  const all = render();
  return {
    all,
    country: all.find((node) => node.type === "select"),
    city: all.find((node) => node.type === "input"),
    save: all.find((node) => node.type === "button" && node.props.children === t("settings.searchLocation.save")),
  };
}

it("loads saved geography independently of interface language and saves only after explicit action", async () => {
  const { api } = await setup({ country: "GB", city: "Derby" });
  let view = fields();
  expect(view.country.props.value).toBe("GB");
  expect(view.city.props.value).toBe("Derby");

  env.locale = "tr";
  setLocale("tr");
  view = fields();
  expect(view.country.props.value).toBe("GB");
  expect(view.all.find((node) => node.type === "option" && node.props.value === "TR").props.children).toBe("Türkiye");
  expect(api.setSearchLocation).not.toHaveBeenCalled();

  view.country.props.onChange({ target: { value: "DE" } });
  view = fields();
  expect(view.city.props.value).toBe("");
  view.city.props.onChange({ target: { value: " Berlin " } });
  fields().save.props.onClick();
  await Promise.resolve();
  expect(api.setSearchLocation).toHaveBeenCalledExactlyOnceWith({ country: "DE", city: "Berlin" });
  expect(fields().all.some((node) => node.props?.role === "status" && node.props.children === t("settings.searchLocation.saved"))).toBe(true);
});

it("unknown default stays blank in every language and city waits for an explicit country", async () => {
  const { api } = await setup();
  for (const locale of ["en", "tr", "de"] as const) {
    env.locale = locale;
    setLocale(locale);
    const view = fields();
    expect(view.country.props.value).toBe("");
    expect(view.city.props.disabled).toBe(true);
    expect(view.save.props.disabled).toBe(true);
  }
  expect(api.setSearchLocation).not.toHaveBeenCalled();
  expect(api.searchLocation).toHaveBeenCalledOnce();
});

it("failed save preserves local values and duplicate clicks do not send twice", async () => {
  const { api } = await setup();
  fields().country.props.onChange({ target: { value: "FR" } });
  fields().city.props.onChange({ target: { value: "Paris" } });
  let reject!: (error: Error) => void;
  api.setSearchLocation = vi.fn(() => new Promise((_resolve, no) => { reject = no; })) as any;
  const view = fields();
  view.save.props.onClick();
  view.save.props.onClick();
  expect(api.setSearchLocation).toHaveBeenCalledOnce();

  reject(Error("Synthetic failure"));
  await Promise.resolve();
  await Promise.resolve();
  const failed = fields();
  expect(failed.country.props.value).toBe("FR");
  expect(failed.city.props.value).toBe("Paris");
  expect(failed.all.some((node) => node.props?.role === "alert" && node.props.children === t("settings.searchLocation.saveError"))).toBe(true);
  expect(failed.save.props.disabled).toBe(false);
});

it("a late load after leaving settings cannot update the unmounted form", async () => {
  env.values = [];
  env.refs = [];
  env.effects = [];
  let finish!: (value: any) => void;
  const api = {
    searchLocation: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    setSearchLocation: vi.fn(),
  };
  vi.stubGlobal("window", { vunemi: api });
  render();
  const cleanup = env.effects[0]!() as () => void;
  cleanup();
  finish({ country: "TR", city: "İstanbul" });
  await Promise.resolve();
  expect(env.values[0]).toBeNull();
  expect(api.setSearchLocation).not.toHaveBeenCalled();
});
