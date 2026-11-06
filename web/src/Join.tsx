// A guest's way to an account: an email or Google, and the canvases they made here come along. The same
// popup signs in to an account they already have.
import { useState } from "react";
import { useConfig } from "./api";
import type { Next } from "./Sidebar";
import { Dialog } from "./Dialog";
import { SignIn } from "./SignIn";
import { Icon, PATH } from "./Icon";
import { lifetime, t } from "./texts";

export function Join({ next, onClose }: { next: Next | null; onClose: () => void }) {
  const [existing, setExisting] = useState(false); // signing in to an account they already have
  const hours = useConfig()?.guestCanvasHours;
  return (
    <Dialog title={existing ? t("signIn") : t("joinTitle")} onClose={onClose} small>
      <section className="join" key={existing ? "in" : "join"}>
        <p className="join-lead">
          {existing
            ? t("signInLead")
            : hours === undefined
              ? null
              : hours === 0
                ? t(next ? "joinLeadSoon" : "joinLeadKept")
                : t("joinLead", { lifetime: lifetime(hours) })}
        </p>
        {next && !existing && (
          <p className="join-left">
            <Icon d={PATH.hourglass} size={15} /> {t("joinLeft", next)}
          </p>
        )}
        <SignIn existing={existing} />
      </section>
      <footer className="about join-switch">
        <span>
          {existing ? t("joinNew") : t("joinExisting")}{" "}
          <button className="link-btn" onClick={() => setExisting(!existing)}>
            {existing ? t("createAccount2") : t("signIn")}
          </button>
        </span>
      </footer>
    </Dialog>
  );
}
