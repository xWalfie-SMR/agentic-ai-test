/**
 * Custom editor extending pi-tui Editor with application-specific keybindings.
 */

import { Editor, Key, matchesKey } from "@mariozechner/pi-tui";

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlT?: () => void;

  override handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) &&
      this.onEscape &&
      !this.isShowingAutocomplete()
    ) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }
    super.handleInput(data);
  }
}
