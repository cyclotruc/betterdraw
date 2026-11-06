import clsx from "clsx";

import { Fragment } from "react";

import { Button } from "../Button";

import type { ReactNode } from "react";

export type TTDPanelAction = {
  label: string;
  action?: () => void;
  icon?: ReactNode;
  variant: "button";
  disabled?: boolean;
  className?: string;
};

interface TTDDialogPanelProps {
  label?: string | ReactNode;
  children: ReactNode;
  panelActions?: TTDPanelAction[];
  renderSubmitShortcut?: () => ReactNode;
  className?: string;
  panelActionJustifyContent?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
}

export const TTDDialogPanel = ({
  label,
  children,
  panelActions = [],
  renderSubmitShortcut,
  className,
  panelActionJustifyContent = "flex-start",
}: TTDDialogPanelProps) => {
  const renderPanelAction = (panelAction: TTDPanelAction) => {
    if (panelAction?.variant === "button") {
      return (
        <Button
          className={clsx("ttd-dialog-panel-button", panelAction.className)}
          onSelect={panelAction.action ? panelAction.action : () => {}}
          disabled={panelAction?.disabled}
        >
          <div>
            {panelAction?.label}
            {panelAction?.icon && <span>{panelAction.icon}</span>}
          </div>
        </Button>
      );
    }
  };

  return (
    <div className={clsx("ttd-dialog-panel", className)}>
      {label && (
        <div className="ttd-dialog-panel__header">
          {typeof label === "string" ? <label>{label}</label> : label}
        </div>
      )}
      {children}
      <div
        className={clsx("ttd-dialog-panel-button-container", {
          invisible: !panelActions.length,
        })}
        style={{
          justifyContent: panelActionJustifyContent,
        }}
      >
        {panelActions.filter(Boolean).map((panelAction) => (
          <Fragment key={panelAction.label}>
            {renderPanelAction(panelAction)}
          </Fragment>
        ))}
        {renderSubmitShortcut?.()}
      </div>
    </div>
  );
};
