import clsx from "clsx";

import { KEYS } from "@betterdraw/common";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { useEditorInterface } from "../App";

const MenuTrigger = ({
  className = "",
  children,
  onToggle,
  title,
  ...rest
}: {
  className?: string;
  children: React.ReactNode;
  onToggle: () => void;
  title?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">) => {
  const editorInterface = useEditorInterface();
  const classNames = clsx(
    `dropdown-menu-button ${className}`,
    "zen-mode-transition",
    {
      "dropdown-menu-button--mobile": editorInterface.formFactor === "phone",
    },
  ).trim();
  return (
    <DropdownMenuPrimitive.Trigger
      className={classNames}
      onClick={onToggle}
      onKeyDown={(event) => {
        // Radix toggles the menu on Enter and Space and opens it on ArrowDown
        // through `onOpenChange`, which DropdownMenu doesn't pass, and cancels
        // the click these keys make. They don't reach the canvas either.
        if (
          event.key === KEYS.ENTER ||
          event.key === KEYS.SPACE ||
          event.key === KEYS.ARROW_DOWN
        ) {
          event.stopPropagation();
          if (
            event.key !== KEYS.ARROW_DOWN ||
            event.currentTarget.getAttribute("aria-expanded") !== "true"
          ) {
            onToggle();
          }
        }
      }}
      type="button"
      data-testid="dropdown-menu-button"
      title={title}
      {...rest}
    >
      {children}
    </DropdownMenuPrimitive.Trigger>
  );
};

export default MenuTrigger;
MenuTrigger.displayName = "DropdownMenuTrigger";
