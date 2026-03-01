import { spawnSync } from "node:child_process";

function runPowerShell(script: string, envVarName: string, envVarValue: string): string {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [envVarName]: envVarValue,
      },
    },
  );

  if (result.error) {
    throw new Error(`Failed to run PowerShell: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || "PowerShell exited with non-zero status").trim());
  }

  return result.stdout.trim();
}

export function encryptSecretWithDpapi(plaintext: string): string {
  if (!plaintext) {
    return "";
  }
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$plain = $env:MODEL_MANAGER_SECRET_PLAIN
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Convert]::ToBase64String($enc)
`;
  return runPowerShell(script, "MODEL_MANAGER_SECRET_PLAIN", plaintext);
}

export function decryptSecretWithDpapi(ciphertextBase64: string): string {
  if (!ciphertextBase64) {
    return "";
  }
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$cipher = $env:MODEL_MANAGER_SECRET_CIPHER
$enc = [System.Convert]::FromBase64String($cipher)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($bytes)
`;
  return runPowerShell(script, "MODEL_MANAGER_SECRET_CIPHER", ciphertextBase64);
}
