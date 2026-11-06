import clsx from "clsx";
import { useState } from "react";

import { KEYS } from "@betterdraw/common";

import { t } from "../i18n";

import { useEditorInterface, useStylesPanelMode } from "./App";
import { HintViewer } from "./HintViewer";
import { LockButton } from "./LockButton";
import { PenModeButton } from "./PenModeButton";
import Stack from "./Stack";
import DropdownMenu from "./dropdownMenu/DropdownMenu";
import {
  drawShapeToolIcon,
  EmbedIcon,
  frameToolIcon,
  LassoIcon,
  bucketFillIcon,
  mermaidLogoIcon,
  chevronDownIcon,
  stickyNoteToolIcon,
} from "./icons";
import {
  ArrowToolButton,
  DiamondToolButton,
  EllipseToolButton,
  EraserToolButton,
  FreedrawToolPopover,
  FreedrawToolButton,
  getToolShortcut,
  HandToolButton,
  ImageToolButton,
  isToolButtonDisabled,
  LaserToolButton,
  LassoToolButton,
  LineToolButton,
  RectangleToolButton,
  SelectionToolButton,
  SelectionToolPopover,
  TextToolButton,
} from "./Tools";

import type {
  AppClassProperties,
  AppProps,
  AppState,
  UIAppState,
} from "../types";

const ExtraToolsDropdown = ({
  app,
  activeTool,
  setAppState,
}: {
  app: AppClassProperties;
  activeTool: UIAppState["activeTool"];
  setAppState: React.Component<any, AppState>["setState"];
}) => {
  const [isExtraToolsMenuOpen, setIsExtraToolsMenuOpen] = useState(false);
  const isFullStylesPanel = useStylesPanelMode() === "full";

  const stickyNoteToolSelected = activeTool.type === "stickynote";
  const frameToolSelected = activeTool.type === "frame";
  const drawShapeToolSelected = activeTool.type === "autoshape";
  const bucketFillToolSelected = activeTool.type === "bucketfill";
  const lassoToolSelected =
    isFullStylesPanel &&
    activeTool.type === "lasso" &&
    app.state.preferredSelectionTool.type !== "lasso";
  const embeddableToolSelected = activeTool.type === "embeddable";

  // the menu's tool in use, which the trigger shows in place of its arrow
  const selectedToolIcon = stickyNoteToolSelected
    ? stickyNoteToolIcon
    : frameToolSelected
    ? frameToolIcon
    : embeddableToolSelected
    ? EmbedIcon
    : isFullStylesPanel && drawShapeToolSelected
    ? drawShapeToolIcon
    : lassoToolSelected
    ? LassoIcon
    : bucketFillToolSelected
    ? bucketFillIcon
    : null;

  return (
    <DropdownMenu open={isExtraToolsMenuOpen}>
      <DropdownMenu.Trigger
        className={clsx("App-toolbar__extra-tools-trigger", {
          "App-toolbar__extra-tools-trigger--selected": !!selectedToolIcon,
        })}
        onToggle={() => {
          setIsExtraToolsMenuOpen(!isExtraToolsMenuOpen);
          setAppState({ openMenu: null, openPopup: null });
        }}
        title={t("toolBar.extraTools")}
        data-testid="toolbar-more"
      >
        {selectedToolIcon || chevronDownIcon}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        onClickOutside={() => setIsExtraToolsMenuOpen(false)}
        onSelect={() => setIsExtraToolsMenuOpen(false)}
        className="App-toolbar__extra-tools-dropdown"
      >
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "stickynote" })}
          icon={stickyNoteToolIcon}
          shortcut={KEYS.N.toLocaleUpperCase()}
          data-testid="toolbar-stickynote"
          selected={stickyNoteToolSelected}
          disabled={isToolButtonDisabled(app, "stickynote")}
        >
          {t("toolBar.stickynote")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "frame" })}
          icon={frameToolIcon}
          shortcut={KEYS.F.toLocaleUpperCase()}
          data-testid="toolbar-frame"
          selected={frameToolSelected}
          disabled={isToolButtonDisabled(app, "frame")}
        >
          {t("element.frame")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "embeddable" })}
          icon={EmbedIcon}
          data-testid="toolbar-embeddable"
          selected={embeddableToolSelected}
          disabled={isToolButtonDisabled(app, "embeddable")}
        >
          {t("toolBar.embeddable")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "autoshape" })}
          icon={drawShapeToolIcon}
          shortcut={getToolShortcut("autoshape")}
          data-testid="toolbar-autoshape"
          selected={drawShapeToolSelected}
          disabled={isToolButtonDisabled(app, "autoshape")}
        >
          {t("toolBar.autoshape")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "bucketfill" })}
          icon={bucketFillIcon}
          data-testid="toolbar-bucketfill"
          selected={bucketFillToolSelected}
          shortcut={KEYS.B.toLocaleUpperCase()}
          disabled={isToolButtonDisabled(app, "bucketfill")}
        >
          {t("toolBar.bucketfill")}
        </DropdownMenu.Item>
        {isFullStylesPanel && (
          <DropdownMenu.Item
            onSelect={() => app.setActiveTool({ type: "lasso" })}
            icon={LassoIcon}
            data-testid="toolbar-lasso"
            selected={lassoToolSelected}
            disabled={isToolButtonDisabled(app, "lasso")}
          >
            {t("toolBar.lasso")}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onSelect={() => app.setOpenDialog({ name: "ttd", tab: "mermaid" })}
          icon={mermaidLogoIcon}
          data-testid="toolbar-mermaid"
        >
          {t("toolBar.mermaidToExcalidraw")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};

/**
 * the main (desktop/tablet) toolbar: its tools in short bars side by side,
 * then the extra tools under an arrow and the laser pointer on their own
 */
export const Toolbar = ({
  app,
  appState,
  setAppState,
  UIOptions,
  onPenModeToggle,
  onLockToggle,
  heading,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  setAppState: React.Component<any, AppState>["setState"];
  UIOptions: AppProps["UIOptions"];
  onPenModeToggle: AppClassProperties["togglePenMode"];
  onLockToggle: () => void;
  heading: React.ReactNode;
}) => {
  const editorInterface = useEditorInterface();
  const isCompactStylesPanel = useStylesPanelMode() === "compact";

  const activeTool = appState.activeTool;
  const toolProps = { app, activeTool };
  const gap = isCompactStylesPanel ? 0.5 : 1;

  return (
    <div
      className={clsx("App-toolbar", {
        "zen-mode": appState.zenModeEnabled,
        "App-toolbar--compact": isCompactStylesPanel,
      })}
      data-viewport-ui="top"
    >
      <HintViewer
        appState={appState}
        isMobile={editorInterface.formFactor === "phone"}
        editorInterface={editorInterface}
        app={app}
      />
      {heading}
      <Stack.Row gap={2} className="App-toolbar__groups">
        <Stack.Row gap={gap} className="App-toolbar__group">
          {/* in compact UI the pen mode button is rendered as a separate
              floating button below the compact actions menu */}
          {!isCompactStylesPanel && (
            <PenModeButton
              checked={appState.penMode}
              onChange={() => onPenModeToggle(null)}
              title={t("toolBar.penMode")}
              penDetected={appState.penDetected}
            />
          )}
          {app.props.activeTool == null && (
            <>
              <LockButton
                checked={appState.activeTool.locked}
                onChange={onLockToggle}
                title={t("toolBar.lock")}
                // the active tool — including its lock state — is host-controlled
                disabled={app.props.activeTool != null}
              />

              <div className="App-toolbar__divider" />
            </>
          )}

          <HandToolButton {...toolProps} />
          {isCompactStylesPanel ? (
            <SelectionToolPopover {...toolProps} setAppState={setAppState} />
          ) : appState.preferredSelectionTool.type === "lasso" ? (
            <LassoToolButton {...toolProps} />
          ) : (
            <SelectionToolButton {...toolProps} />
          )}
        </Stack.Row>
        <Stack.Row gap={gap} className="App-toolbar__group">
          <RectangleToolButton {...toolProps} />
          <DiamondToolButton {...toolProps} />
          <EllipseToolButton {...toolProps} />
          <ArrowToolButton {...toolProps} />
          <LineToolButton {...toolProps} />
        </Stack.Row>
        <Stack.Row gap={gap} className="App-toolbar__group">
          {isCompactStylesPanel ? (
            <FreedrawToolPopover {...toolProps} />
          ) : (
            <FreedrawToolButton {...toolProps} />
          )}
          <TextToolButton {...toolProps} />
          {UIOptions.tools?.image !== false && (
            <ImageToolButton {...toolProps} />
          )}
          <EraserToolButton {...toolProps} />
        </Stack.Row>
        <Stack.Row className="App-toolbar__group">
          <ExtraToolsDropdown
            app={app}
            activeTool={activeTool}
            setAppState={setAppState}
          />
        </Stack.Row>
        <Stack.Row className="App-toolbar__group">
          <LaserToolButton {...toolProps} />
        </Stack.Row>
      </Stack.Row>
    </div>
  );
};
