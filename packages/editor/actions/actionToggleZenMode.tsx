import { KEYS, matchKey } from "@betterdraw/common";

import { CaptureUpdateAction } from "@betterdraw/element";

import { coffeeIcon } from "../components/icons";

import { register } from "./register";

export const actionToggleZenMode = register({
  name: "zenMode",
  label: "buttons.zenMode",
  icon: coffeeIcon,
  viewMode: true,
  trackEvent: {
    category: "canvas",
    predicate: (appState) => !appState.zenModeEnabled,
  },
  perform(elements, appState) {
    return {
      appState: {
        ...appState,
        zenModeEnabled: !this.checked!(appState),
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  checked: (appState) => appState.zenModeEnabled,
  predicate: (elements, appState, appProps, app) => {
    return (
      app.editorInterface.formFactor !== "phone" &&
      typeof appProps.zenModeEnabled === "undefined"
    );
  },
  // the key marked Z on any layout (on AZERTY it sits where QWERTY has W);
  // macOS turns Option+Z into "Ω", where the physical key decides
  keyTest: (event) =>
    !event[KEYS.CTRL_OR_CMD] && event.altKey && matchKey(event, KEYS.Z),
});
