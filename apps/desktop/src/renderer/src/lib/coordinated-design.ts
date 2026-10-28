export async function copyAnswer(text: string, clipboard: Pick<Clipboard, "writeText">): Promise<void> {
  await clipboard.writeText(text);
}
