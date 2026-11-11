const SECRET_PAIR = /\b(auth_token|ct0|sessionid|csrftoken)=([^\s;'"&]+)/gi;

/** Hides cookie values that gallery-dl may echo into a log, before the log is shown on screen. */
export function maskSecrets(text: string): string {
  return text.replace(SECRET_PAIR, "$1=••••");
}
