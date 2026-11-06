import React from "react";

import { KEYS } from "@betterdraw/common";

import { Excalidraw } from "../../index";
import { API } from "../../tests/helpers/api";
import { Keyboard } from "../../tests/helpers/ui";
import {
  render,
  waitFor,
  getByTestId,
  fireEvent,
} from "../../tests/test-utils";

describe("Test <DropdownMenu/>", () => {
  it("closes on Escape", async () => {
    const { container } = await render(<Excalidraw />);

    expect(window.h.state.openMenu).toBe(null);

    fireEvent.click(getByTestId(container, "main-menu-trigger"));
    expect(window.h.state.openMenu).toBe("canvas");

    await waitFor(() => {
      Keyboard.keyDown(KEYS.ESCAPE);
      expect(window.h.state.openMenu).toBe(null);
    });
  });

  it("opens from the keyboard, keeping the keys from the canvas", async () => {
    const { container } = await render(<Excalidraw />);
    const rectangle = API.createElement({ type: "rectangle", x: 10, y: 10 });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    const trigger = getByTestId(container, "toolbar-more");
    const menu = () => container.querySelector('[data-testid="dropdown-menu"]');

    for (const key of [KEYS.ENTER, KEYS.SPACE]) {
      fireEvent.keyDown(trigger, { key });
      await waitFor(() => expect(menu()).not.toBeNull());
      fireEvent.keyDown(trigger, { key });
      await waitFor(() => expect(menu()).toBeNull());
    }

    trigger.focus();
    fireEvent.keyDown(trigger, { key: KEYS.ARROW_DOWN });
    await waitFor(() => expect(menu()).not.toBeNull());
    fireEvent.keyDown(document.activeElement!, { key: KEYS.ARROW_DOWN });
    expect(menu()).not.toBeNull();
    expect(window.h.elements[0].y).toBe(10);
    expect(window.h.state.editingTextElement).toBe(null);

    Keyboard.keyDown(KEYS.ESCAPE);
    await waitFor(() => {
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it.each([
    ["main menu", '[data-testid="main-menu-trigger"]'],
    ["more tools", ".App-toolbar__extra-tools-trigger"],
  ])(
    "closes %s on outside pointer and touch events after reopening",
    async (_, triggerSelector) => {
      const { container } = await render(<Excalidraw />);
      const trigger = container.querySelector<HTMLElement>(triggerSelector)!;
      const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
      const toolbar = getByTestId(container, "toolbar-rectangle");

      for (const outsideTarget of [canvas, toolbar]) {
        for (const event of [fireEvent.pointerDown, fireEvent.touchStart]) {
          fireEvent.click(trigger);
          await waitFor(() => {
            expect(
              container.querySelector('[data-testid="dropdown-menu"]'),
            ).not.toBeNull();
          });

          event(outsideTarget);
          await waitFor(() => {
            expect(
              container.querySelector('[data-testid="dropdown-menu"]'),
            ).toBeNull();
          });
        }
      }
    },
  );
});
