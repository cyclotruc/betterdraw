// What agents just did, as cards in the top right: who, what, when. The whole card is a button that shows
// the change and puts the card away; × puts it away without going there. Cards stay until then.
// Further changes by the same agent update its card instead of stacking a new one.
import { useEffect, useState } from "react";
import { avatarURL } from "./avatar";
import { ago, t } from "./texts";

export type AgentCard = { key: string; name: string; what: string; onShow: () => void };
type Card = AgentCard & { at: number; rev: number };

const MAX = 3;
let push: (c: AgentCard) => void = () => {};
export const agentCard = (c: AgentCard) => push(c);

export function AgentCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [, tick] = useState(0);
  useEffect(() => {
    push = (c) =>
      setCards((list) => {
        const old = list.find((x) => x.key === c.key);
        return [{ ...c, at: Date.now(), rev: (old?.rev ?? 0) + 1 }, ...list.filter((x) => x.key !== c.key)].slice(0, MAX);
      });
    const timer = setInterval(() => tick((n) => n + 1), 30_000); // keeps "2 min ago" true
    return () => {
      push = () => {};
      clearInterval(timer);
    };
  }, []);
  const close = (key: string) => setCards((list) => list.filter((x) => x.key !== key));
  return (
    <div className="agent-cards" role="status" aria-live="polite">
      {cards.map((c) => (
        <CardView key={c.key} card={c} onClose={() => close(c.key)} />
      ))}
    </div>
  );
}

function CardView({ card, onClose }: { card: Card; onClose: () => void }) {
  const show = () => {
    card.onShow();
    onClose();
  };
  return (
    <div
      className="agent-card"
      role="button"
      tabIndex={0}
      title={t("show")}
      onClick={show}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), show())}
    >
      <span className="ac-face">
        <img src={avatarURL(card.name, true)} alt="" />
      </span>
      <span className="ac-text">
        <strong>{card.name}</strong>
        <span className="ac-what">
          {card.what} <span className="ac-time">{ago(new Date(card.at).toISOString())}</span>
        </span>
      </span>
      <button
        type="button"
        className="ac-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={t("close")}
        title={t("close")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
