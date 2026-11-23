exports.version = 2.1
exports.apiRequired = 10.0
exports.description = "NAS-optimized drive monitor. Passive mode subscribes to Windows event log; aggressive mode polls drive letters."
exports.repo = "hugo529100/hfs-Disk-monitor"

const { spawn } = require('child_process')

exports.config = {
    enabled: {
        type: 'boolean',
        label: 'Enable monitoring',
        defaultValue: true
    },
    monitorMode: {
        type: 'select',
        label: 'Monitor mode',
        helperText: 'Passive: subscribe to Windows event log (recommended, does not wake HDDs). Aggressive: poll drive letters (may wake HDDs).',
        options: {
            passive: 'Passive (Event Log)',
            aggressive: 'Aggressive (Polling)'
        },
        defaultValue: 'passive'
    },
    drives: {
        type: 'multiselect',
        label: 'Drives to monitor',
        helperText: 'Select drive letters to monitor (aggressive mode only)',
        options: {
            "D:": "D:", "E:": "E:", "F:": "F:", "G:": "G:", "H:": "H:",
            "I:": "I:", "J:": "J:", "K:": "K:", "L:": "L:", "M:": "M:",
            "N:": "N:", "O:": "O:", "P:": "P:", "Q:": "Q:", "R:": "R:",
            "S:": "S:", "T:": "T:", "U:": "U:", "V:": "V:", "W:": "W:",
            "X:": "X:", "Y:": "Y:", "Z:": "Z:"
        },
        defaultValue: []
    },
    interval: {
        type: 'number',
        label: 'Check interval (seconds)',
        helperText: 'Only used in aggressive mode. Lower values increase disk wake-up frequency.',
        min: 2,
        defaultValue: 2
    }
}

exports.init = api => {

    const fs = api.require('fs')

    let timer
    let psProcess = null
    let state = new Map()

    // ---------- Aggressive mode: polling ----------

    function checkDrives() {

        if (!api.getConfig('enabled'))
            return

        const drives = api.getConfig('drives') || []
        if (!drives.length)
            return

        for (const drive of drives) {

            const exists = fs.existsSync(drive + '\\')
            const previous = state.get(drive)

            if (previous === undefined) {
                state.set(drive, exists)
                continue
            }

            if (previous && !exists) {
                api.log('[DiskMonitor] DRIVE OFFLINE:', drive)
            }

            state.set(drive, exists)
        }
    }

    // ---------- Passive mode: Windows event log subscription ----------

    // Fixed categories: disk errors and drive removal/offline.
    // Event IDs:
    //   error  : 7 (bad block), 55 (file system corruption),
    //            129 (reset/timeout), 153 (I/O retried)
    //   removal: 157 (surprise removed), 225/226 (Kernel-PnP device removal)
    const ERROR_IDS = [7, 55, 129, 153]
    const REMOVAL_IDS = [157, 225, 226]

    function categorize(event) {
        const src = event.Source || ''
        const id = event.Id

        if (ERROR_IDS.includes(id))
            return 'error'
        if (REMOVAL_IDS.includes(id) || src === 'Microsoft-Windows-Kernel-PnP')
            return 'removal'
        return null
    }

    function startPassive() {

        const ids = new Set([...ERROR_IDS, ...REMOVAL_IDS])
        const idFilter = Array.from(ids).map(i => `EventID=${i}`).join(' or ')

        const script = `
            $ErrorActionPreference = 'SilentlyContinue'
            $query = @'
<QueryList>
  <Query Id="0" Path="System">
    <Select Path="System">*[System[(${idFilter})]]</Select>
  </Query>
</QueryList>
'@
            Register-WinEvent -LogName System -FilterXml $query -Action {
                $e = $EventArgs.Event
                $out = @{
                    Id = $e.Id
                    Source = $e.ProviderName
                    Level = $e.LevelDisplayName
                    Time = $e.TimeCreated.ToString('o')
                    Message = $e.Message
                } | ConvertTo-Json -Compress
                [Console]::Out.WriteLine($out)
                [Console]::Out.Flush()
            }
            while ($true) { Start-Sleep -Seconds 3600 }
        `

        psProcess = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true }
        )

        let buffer = ''

        psProcess.stdout.on('data', data => {
            buffer += data.toString()
            let idx
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim()
                buffer = buffer.slice(idx + 1)
                if (!line) continue
                try {
                    const event = JSON.parse(line)
                    const category = categorize(event)
                    if (!category)
                        continue

                    const severity = (event.Id === 7 || event.Id === 55) ? 'ERROR' : 'WARNING'
                    api.log(
                        `[DiskMonitor] ${category.toUpperCase()} ${severity}:`,
                        'id=' + event.Id,
                        'source=' + event.Source,
                        'level=' + event.Level,
                        'time=' + event.Time,
                        'message=' + event.Message
                    )
                } catch (e) {
                    // Ignore non-JSON output
                }
            }
        })

        psProcess.stderr.on('data', data => {
            const msg = data.toString().trim()
            if (msg)
                api.log('[DiskMonitor] PowerShell error:', msg)
        })

        psProcess.on('close', code => {
            api.log('[DiskMonitor] Event listener exited with code:', code)
            psProcess = null
        })
    }

    function stopPassive() {
        if (psProcess) {
            try { psProcess.kill() } catch (e) { /* ignore */ }
            psProcess = null
        }
    }

    // ---------- Lifecycle ----------

    function start() {

        if (timer) {
            clearInterval(timer)
            timer = null
        }
        stopPassive()

        if (!api.getConfig('enabled'))
            return

        const mode = api.getConfig('monitorMode') || 'passive'

        if (mode === 'passive') {
            startPassive()
        } else {
            const interval = api.getConfig('interval') || 2
            timer = api.setInterval(checkDrives, interval * 1000)
        }
    }

    start()

    api.subscribeConfig(['enabled', 'interval', 'monitorMode'], () => {
        state.clear()
        start()
    })

    api.subscribeConfig('drives', () => {
        state.clear()
    })

    return {
        unload() {
            if (timer)
                clearInterval(timer)
            stopPassive()
        }
    }
}