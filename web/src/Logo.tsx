// The betterdraw mark: a clean orange square with a white b, laid over its own hachure sketch. The sketch
// takes the text color, so it follows the theme. web/public/favicon.svg is the
// same drawing redrawn on a 16px grid (straight outline, four hachures) so it stays crisp in a tab.
import brand from "../../branding/brand.json";

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M1.5 4.25 4.25 1.5M1.5 9.75 9.75 1.5M1.5 15.25 15.25 1.5M2.75 19.5 19.5 2.75M8.25 19.5 19.5 8.25M13.75 19.5 19.5 13.75M19.25 19.5 19.5 19.25M.8 2.6 20 1.6 20.5 20 1.6 20.6 2.2 .8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="8" y="8" width="23" height="23" rx="5" fill={brand.accent} />
      <path fill="#fff" d="M12.82 13.45 17.95 11.25V27.75H12.82Z" />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M20.52 16.01a5.87 5.87 0 1 1 0 11.74a5.87 5.87 0 1 1 0 -11.74Zm0 3.3a2.57 2.57 0 1 0 0 5.14a2.57 2.57 0 1 0 0 -5.14Z"
      />
    </svg>
  );
}
