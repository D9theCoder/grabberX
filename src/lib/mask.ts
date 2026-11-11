const SECRET_PAIR = /\b(auth_token|ct0|sessionid|csrftoken)=([^\s;'"&]+)/gi;
// The key may be quoted when gallery-dl dumps a header dict; keep the key and separator so the line stays readable.
const SECRET_HEADER = /\b(set-cookie|cookie|authorization)(["']?\s*:\s*)[^\r\n]*/gi;
// Userinfo cannot contain "/", "?" or "#" (they start the path/query/fragment), so an "@" later in a
// normal URL can never be reached from the scheme: only real credentials match. "@" itself is allowed
// inside the match, so the greedy run ends at the last "@" and a password containing "@" is fully
// hidden. The scheme length is bounded so a long run of letters cannot make the scan quadratic.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#"'<>]+)@/gi;

function maskUserinfo(_match: string, scheme: string, userinfo: string): string {
  const colon = userinfo.indexOf(":");
  return colon === -1 ? `${scheme}••••@` : `${scheme}${userinfo.slice(0, colon)}:••••@`;
}

/** Hides cookie values, header values and URL credentials that gallery-dl may echo into its output. */
export function maskSecrets(text: string): string {
  return text
    .replace(SECRET_HEADER, (_match, name: string, separator: string) => `${name}${separator}••••`)
    .replace(URL_CREDENTIALS, maskUserinfo)
    .replace(SECRET_PAIR, "$1=••••");
}
