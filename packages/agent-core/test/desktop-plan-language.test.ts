import { afterEach, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { desktopAppendWorkflow, desktopBindings } from "../src/desktop-progress.js";
import type { TaskRecord } from "../src/tasks.js";

const goal = 'In TextEdit, in the background, append "Hello." to /Users/ada/Documents/notes.txt and save it.';
const task = (steps: string[]) => ({ goal, planAccepted: true, steps: steps.map((title) => ({ title })) }) as unknown as TaskRecord;

afterEach(() => setLocale("tr"));

it("writes the fixed plan in the app's language, not always in Turkish", () => {
  setLocale("en");
  expect(desktopAppendWorkflow(goal)?.steps).toEqual([
    "notes.txt: open the document without changing focus.",
    "notes.txt: add the requested text once.",
    "notes.txt: save and check the content on disk.",
  ]);
  setLocale("tr");
  expect(desktopAppendWorkflow(goal)?.steps[0]).toBe("notes.txt: belgeyi odağı değiştirmeden aç.");
});

it("still knows a task planned in another language", () => {
  setLocale("tr");
  const planned = desktopAppendWorkflow(goal)!.steps;
  setLocale("en");
  expect(desktopBindings(task(planned))?.steps).toEqual(planned);
  expect(desktopBindings(task(["Something else.", "Another step.", "A third."]))).toBeNull();
  expect(desktopBindings({ ...task(planned), planAccepted: false } as TaskRecord)).toBeNull();
});
