import React from "react";

import { KEYS } from "@betterdraw/common";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { fireEvent, render, waitFor } from "./test-utils";

describe("shortcuts", () => {
  it("Clear canvas shortcut should display confirm dialog", async () => {
    await render(
      <Excalidraw
        initialData={{ elements: [API.createElement({ type: "rectangle" })] }}
        handleKeyboardGlobally
      />,
    );

    expect(window.h.elements.length).toBe(1);

    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyDown(KEYS.DELETE);
    });
    const confirmDialog = document.querySelector(".confirm-dialog")!;
    expect(confirmDialog).not.toBe(null);

    fireEvent.click(confirmDialog.querySelector('[aria-label="Confirm"]')!);

    await waitFor(() => {
      expect(window.h.elements[0].isDeleted).toBe(true);
    });
  });

  it("Alt+Z toggles zen mode from the key marked Z, on any layout", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    const press = (key: string, code: string) =>
      fireEvent.keyDown(document, { key, code, altKey: true });

    press("z", "KeyZ"); // QWERTY
    expect(window.h.state.zenModeEnabled).toBe(true);
    press("z", "KeyW"); // AZERTY, where Z sits on QWERTY's W
    expect(window.h.state.zenModeEnabled).toBe(false);
    press("Ω", "KeyZ"); // macOS, Option+Z
    expect(window.h.state.zenModeEnabled).toBe(true);
    press("w", "KeyZ"); // AZERTY's W, on QWERTY's Z: not zen mode
    expect(window.h.state.zenModeEnabled).toBe(true);
  });

  it("Ctrl+K links the selected element, and is left to the host without one", async () => {
    const rect = API.createElement({ type: "rectangle" });
    await render(
      <Excalidraw initialData={{ elements: [rect] }} handleKeyboardGlobally />,
    );
    // false when the editor took the key (it prevents the default)
    const ctrlK = () =>
      fireEvent.keyDown(document, { key: KEYS.K, ctrlKey: true });

    expect(ctrlK()).toBe(true);
    expect(window.h.state.showHyperlinkPopup).toBe(false);

    API.setSelectedElements([rect]);
    expect(ctrlK()).toBe(false);
    expect(window.h.state.showHyperlinkPopup).toBe("editor");
  });
});
