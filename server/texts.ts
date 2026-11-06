// The few strings the server writes itself: emails and guest names.
const adjectives = ["curious", "quick", "quiet", "happy", "calm", "clever", "lively", "gentle"];
const animals = ["fox", "otter", "owl", "panda", "lynx", "beaver", "hedgehog", "penguin"];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
export const guestName = () => `${pick(adjectives)} ${pick(animals)}`;

export const mailText = {
  subject: (app: string) => `Sign in to ${app}`,
  title: "Sign in",
  intro: "Open this link to sign in. It works for 10 minutes.",
  button: "Sign in",
  orLink: "Or copy this link into your browser:",
  ignore: "If you did not ask to sign in, ignore this email.",
  testSubject: (app: string) => `${app}: test email`,
  testBody: "Email sending works.",
  signup: {
    subject: (app: string) => `Finish creating your ${app} account`,
    title: "Welcome!",
    intro: "One step left: open this link and choose your password. It works for 10 minutes.",
    button: "Choose my password",
    orLink: "Or copy this link into your browser:",
    ignore: "If you did not sign up, ignore this email: no account is created.",
  },
  password: {
    subject: (app: string) => `Choose your ${app} password`,
    title: "Choose a password",
    intro: "Open this link to choose your password. It works for one hour.",
    button: "Choose a password",
    orLink: "Or copy this link into your browser:",
    ignore: "If you did not ask for it, ignore this email: nothing changes on your account.",
  },
};
