/**
 * Minimal environment inherited by automated agent processes.
 *
 * The gateway may have deployment, cloud, or signing credentials in
 * process.env. Provider CLIs are an untrusted execution boundary, so they get
 * only OS/runtime discovery plus credentials explicitly granted by both the
 * project and agent through the encrypted Vault.
 */
const AGENT_RUNTIME_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "COLORTERM",
  // Windows runtime/config discovery.
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
] as const;

const DOCKER_CLIENT_KEYS = [
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
] as const;

export function agentRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return selectDefined(source, AGENT_RUNTIME_KEYS);
}

export function dockerClientEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...agentRuntimeEnvironment(source), ...selectDefined(source, DOCKER_CLIENT_KEYS) };
}

function selectDefined(source: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
