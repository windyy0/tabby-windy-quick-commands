const { spawnSync } = require('child_process')

// WMI starts this broker outside the terminal's process tree. Give PowerShell valid
// standard handles: launching pwsh directly from WMI can exit before running code.
// No shell is involved; all cleanup paths stay in the encoded PowerShell payload.
const result = spawnSync(process.argv[2], [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', process.argv[3],
], { windowsHide: true, stdio: 'ignore' })

process.exit(result.status ?? 1)
