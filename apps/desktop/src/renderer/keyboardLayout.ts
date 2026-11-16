// The character each key types on this keyboard (without Shift), from Chromium's layout map: on
// Swedish and other Nordic layouts + is where an American keyboard has − and − where it has /,
// so shortcuts made of punctuation go by the character, not the key's place.

let layout: Map<string, string> | null = null

async function read() {
  try {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard
    if (kb?.getLayoutMap) layout = new Map((await kb.getLayoutMap()).entries())
  } catch {
    /* not offered: the key as typed, below */
  }
}
void read()
// A layout switched while Studio was in the background is read again on coming back.
window.addEventListener('focus', () => void read())

/** The character the key types without Shift, when it can be known. */
export function keyChar(e: KeyboardEvent): string | null {
  const c = layout?.get(e.code)
  if (c) return c.toLowerCase()
  return !e.shiftKey && e.key.length === 1 ? e.key.toLowerCase() : null
}
