/** Environment filtering and diagnostic redaction for the owned DSH process. */

const SAFE_ENVIRONMENT_NAMES = new Set([
  'APPDATA',
  'COMSPEC',
  'DSH_HOME',
  'DSH_TELEMETRY_DISABLED',
  'DSH_TELEMETRY_MODE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
])

/** Environment-name format reserved for extension-managed model credentials. */
const MANAGED_CREDENTIAL_PATTERN = /^DSH_VSCODE_[A-Z0-9]+(?:_[A-Z0-9]+)*_API_KEY$/

/**
 * Copy only operating-system and DSH location values needed to launch the
 * runtime. Model credentials are accepted only through the explicit argument,
 * never inherited from the Extension Host.
 * @param source - ambient Extension Host environment.
 * @param credentials - extension-owned credential variables for this launch.
 * @returns a new environment object safe to pass to the child process.
 */
export function runtimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  credentials: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase())) environment[name] = value
  }
  for (const [name, value] of Object.entries(credentials)) {
    if (!isManagedCredentialReference(name)) {
      throw new Error(`Explicit runtime credential name ${name} is not managed by the DSH extension`)
    }
    if (value !== undefined) environment[name] = value
  }
  return environment
}

/** Whether a reference can be injected as an extension-managed credential. */
export function isManagedCredentialReference(name: string): boolean {
  return MANAGED_CREDENTIAL_PATTERN.test(name)
}

/**
 * Remove common credential forms from child diagnostics before display or
 * retention. This is a final log fence, not a credential parser.
 * @param text - untrusted stderr text.
 * @returns redacted diagnostic text.
 */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,"']+/gi, '$1[redacted]')
}
