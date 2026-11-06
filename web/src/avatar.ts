// A small drawn portrait from a name, with no image and no service: people get a face, agents a robot.
// Ported from chatroom.sh, which draws the same parts for the same name. Keep the seed prefix and the
// order of every part list: changing either gives every name a new face. Only the colors are ours.
const colors = ["#ff922b", "#b197fc", "#69db7c", "#74c0fc", "#ffd43b", "#f783ac"];
const backs = ["#ffe8cc", "#e5dbff", "#d3f9d8", "#d0ebff", "#fff3bf", "#ffdeeb"]; // the same colors, light
const cream = "#fff4e6";
const ink = "#1e1e1e";

function nicknameSeed(name: string) {
  let seed = 2166136261;
  for (const byte of new TextEncoder().encode("avatar-v1:" + name.trim().normalize("NFC"))) seed = Math.imul(seed ^ byte, 16777619);
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x85ebca6b);
  seed ^= seed >>> 13;
  return seed >>> 0;
}

function avatarSVG(name: string, agent: boolean) {
  const seed = nicknameSeed(name),
    color = colors[seed % colors.length],
    back = backs[seed % colors.length];
  const part = (shift: number, count: number) => (seed >>> shift) % count;
  const eyes = [
    '<circle cx="25" cy="32" r="2"/><circle cx="39" cy="32" r="2"/>',
    '<path d="M22 32h6m8 0h6" fill="none"/>',
    `<circle cx="25" cy="32" r="3" fill="${cream}"/><circle cx="39" cy="32" r="3" fill="${cream}"/>`,
    '<path d="M22 33l3-2 3 2m8 0 3-2 3 2" fill="none"/>',
  ][part(5, 4)];
  const mouth = (
    !agent
      ? [
          '<path d="M28 39q4 4 8 0" fill="none"/>',
          '<path d="M28 39q4 6 8 0Z"/>',
          '<path d="M29 40h6" fill="none"/>',
          '<path d="M28 39q4 3 8-1" fill="none"/>',
        ]
      : [
          '<path d="M27 40h10" fill="none"/>',
          '<path d="M27 38q5 6 10 0" fill="none"/>',
          `<rect x="27" y="38" width="10" height="4" rx="1" fill="${cream}"/>`,
          '<path d="M28 39h8m-5-1v2m3-2v2" fill="none"/>',
        ]
  )[part(8, 4)];
  let face;
  if (!agent) {
    const hair = [
      '<path d="M19 28v-9c0-6 5-9 12-9l-2-4c12 0 18 7 16 20l-7-9c-4 6-10 5-19 11Z"/>',
      '<path d="M19 28c-6-2-5-10 0-11-1-6 6-9 10-5 4-6 12-3 12 2 7 0 10 9 4 13l-5-7-5 3-6-3-5 7Z"/>',
      '<path d="M17 30v-6q0-14 15-14t15 14v6l-6-5-3-8-4 7-11 1Z"/>',
      '<path d="M19 27v-8q0-8 9-8h9q8 0 8 8v8l-5-7-4 2-4-2-8 3Z"/>',
    ][part(11, 4)];
    const long = part(11, 4) === 2 ? '<path d="M17 43V25h30v18q-15 7-30 0Z"/>' : "";
    face = `<g fill="${color}">${long}<path d="M10 63v-6q2-11 22-11t22 11v6"/></g><path d="M26 44v6q6 6 12 0v-6" fill="${cream}"/><rect x="20" y="17" width="24" height="30" rx="12" fill="${cream}"/><g fill="${color}">${hair}</g><g transform="translate(0 -1)">${eyes}${mouth}</g>`;
  } else {
    const head = [
      '<rect x="14" y="19" width="36" height="30" rx="6"/>',
      '<path d="M20 18h24l7 8v16l-7 7H20l-7-7V26Z"/>',
      '<rect x="16" y="17" width="32" height="34" rx="10"/>',
      '<path d="M18 19h28l4 30H14Z"/>',
    ][part(11, 4)];
    const antenna = [
      '<path d="M32 23V12"/><circle cx="32" cy="9" r="3"/>',
      '<path d="M23 23V12h18v11" fill="none"/>',
      '<path d="M28 23V11h9" fill="none"/><circle cx="39" cy="11" r="2"/>',
      '<path d="M24 23l-5-14m21 14 5-14" fill="none"/><circle cx="19" cy="9" r="2"/><circle cx="45" cy="9" r="2"/>',
    ][part(15, 4)];
    const ears = [
      '<path d="M20 28H9v11h11m24-11h11v11H44"/>',
      '<path d="M12 33h8m24 0h8"/><circle cx="12" cy="33" r="3"/><circle cx="52" cy="33" r="3"/>',
      '<path d="M12 27v14m0-8h8m24 0h8m0-6v14" fill="none"/>',
    ][part(18, 3)];
    face = `<g fill="${color}">${antenna}${ears}<path d="M24 47h16v10H24Z"/><path d="M19 63v-8h26v8"/>${head}</g><rect x="18" y="25" width="28" height="20" rx="4" fill="${cream}"/>${eyes}${mouth}`;
  }
  // Only fixed parts and palette colors enter the markup; the name never does.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 4 48 48"><rect x="8" y="4" width="48" height="48" fill="${back}"/><g fill="${ink}" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${face}</g></svg>`;
}

// As an image address, for an <img> or Excalidraw's collaborator list, one per name and kind.
const urls = new Map<string, string>();
export function avatarURL(name: string, agent = false) {
  const key = (agent ? "a:" : "h:") + name;
  let url = urls.get(key);
  if (!url) urls.set(key, (url = "data:image/svg+xml," + encodeURIComponent(avatarSVG(name, agent))));
  return url;
}

// Their own picture when they have one, else the drawn face.
export const avatarSrc = (name: string, image?: string | null, agent = false) => image || avatarURL(name, agent);
